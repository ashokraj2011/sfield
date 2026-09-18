/** Public SDK entry point (§4.3, §7, §20, §23). */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Actor, JsonObject, JsonValue, Principal, PublicError } from "./types/common.js";
import type { EffectiveConfig, EffectiveConnectionConfig, EffectiveModelConfig } from "./config/types.js";
import type { ContextExplanation } from "./types/context.js";
import type { MemoryHandle } from "./types/memory.js";
import type { ModelBinding } from "./types/model.js";
import type { ConnectionResolver, HealthReport, HostBindings, HostLimits, SFieldOptions, SecretResolver } from "./types/options.js";
import type { ApprovalRecord, ArtifactStore, AuditRecord, ExecutionPersistence, InputRequestRecord, LockApprovalRecord } from "./types/persistence.js";
import type { PresetComponents, PresetModule } from "./types/preset.js";
import type { RetrievalBinding } from "./types/retrieval.js";
import type { RunHandle, RunSnapshot, Session } from "./types/runtime.js";
import type { DefineToolInput, ToolDefinition } from "./types/tool.js";
import { ConfigErrors, SFieldError } from "./errors.js";
import { loadConfigDocument, loadConfigFile, type LoadedDocument } from "./config/load.js";
import { compileConfig, GENERIC_PARAMS, PROVIDER_PARAMS, shorthandIdentity, type CompileContext } from "./config/compile.js";
import { explainConfig, formatExplanation } from "./config/explain.js";
import { HOST_DEFAULTS } from "./config/defaults.js";
import { ToolRegistry, type ToolDescription } from "./registry/registry.js";
import { PluginManager } from "./plugins/manager.js";
import { AnthropicProvider } from "./gateway/providers/anthropic.js";
import { OpenAICompatibleProvider } from "./gateway/providers/openai-compatible.js";
import { ModelGateway } from "./gateway/gateway.js";
import { EnvSecretResolver, CompositeSecretResolver } from "./secrets.js";
import { Scrubber } from "./util/scrub.js";
import { newId, nowIso } from "./util/digest.js";
import { InMemoryArtifactStore } from "./persistence/artifacts-memory.js";
import { InMemoryMemoryRepository } from "./memory/repository-memory.js";
import { MemoryService } from "./memory/service.js";
import { RetrievalService } from "./retrieval/service.js";
import { ApprovalService } from "./policy/approvals.js";
import { ToolPipeline } from "./pipeline/execute.js";
import { AgentRuntime, type ConfigVersion } from "./runtime/runtime.js";
import { Scheduler } from "./runtime/scheduler.js";
import { EventBus } from "./runtime/events.js";
import { RunService } from "./runtime/run-service.js";
import { ExternalExecutionScope, type ExecutionScope, type ExecutionScopeOptions } from "./runtime/execution-scope.js";
import { approveLock, checkLockApproved, type ApproveLockInput } from "./governance/lock.js";
import { buildContext, type ContextBuildOutput } from "./context/builder.js";
import { computeEffectiveTools } from "./registry/effective.js";
import { toolOverheadTokens } from "./gateway/providers/shared.js";
import type { ExposedTool } from "./types/tool.js";

export const PROVIDER_DEFAULT_LIMITS: Readonly<Record<string, { contextWindow: number; maxOutputTokens: number }>> = Object.freeze({
  anthropic: { contextWindow: 200000, maxOutputTokens: 8192 },
  openai_compatible: { contextWindow: 128000, maxOutputTokens: 4096 },
});

export interface ValidateOptions extends Omit<SFieldOptions, "config"> {
  config: string | JsonObject;
  /** Loader override for tests. */
  presetLoader?: (name: string) => Promise<PresetModule>;
}

export interface ValidationReport {
  ok: boolean;
  errors: PublicError[];
  digest?: string;
  notes: EffectiveConfig["notes"];
  effective?: EffectiveConfig;
}

export interface SFieldCreateOptions extends SFieldOptions {
  presetLoader?: (name: string) => Promise<PresetModule>;
}

interface Internals {
  options: SFieldCreateOptions;
  /** Loaded configuration versions by digest; `current` receives new runs (§20.2). */
  versions: Map<string, ConfigVersion>;
  current: ConfigVersion & { retrievalBindings: Map<string, RetrievalBinding> };
  registry: ToolRegistry;
  plugins: PluginManager;
  persistence: ExecutionPersistence;
  artifacts: ArtifactStore;
  memory: MemoryService;
  approvals: ApprovalService;
  pipeline: ToolPipeline;
  gateway: ModelGateway;
  runtime: AgentRuntime;
  scheduler: Scheduler;
  bus: EventBus;
  runs: RunService;
  secrets: SecretResolver;
  scrubber: Scrubber;
  preset?: PresetComponents;
  deployment: "ephemeral" | "durable_single" | "service";
  limits: HostLimits;
  ownerId: string;
  devPrincipal?: Principal;
  stopController: AbortController;
}

export class SField {
  private closed = false;
  private constructor(readonly i: Internals) {}

  // ------------------------------------------------------------ construction

  static async validate(options: ValidateOptions): Promise<ValidationReport> {
    try {
      const { loaded, ctx } = await prepareCompile(options as SFieldCreateOptions, { validateOnly: true });
      const effective = compileConfig(loaded, ctx);
      return { ok: true, errors: [], digest: effective.digest, notes: effective.notes, effective };
    } catch (e) {
      if (e instanceof ConfigErrors) return { ok: false, errors: e.errors.map((x) => x.toPublic()), notes: [] };
      if (e instanceof SFieldError) return { ok: false, errors: [e.toPublic()], notes: [] };
      throw e;
    }
  }

  static async create(options: SFieldCreateOptions): Promise<SField> {
    const { loaded, ctx, registry, plugins, preset, secrets, limits, deployment, configDir } = await prepareCompile(options, { validateOnly: false });
    const config = compileConfig(loaded, ctx);
    for (const t of Object.values(config.tools)) registry.registerConfigured(t);
    registry.verifyLock(config.lock);

    const persistence = options.persistence ?? preset?.persistence;
    if (!persistence) throw new SFieldError("INVALID_CONFIG", "persistence is required without a preset", { path: "options.persistence", suggestion: "Pass persistence (for example @sfield/store-sqlite) or preset: \"local\"" });
    const authorizer = options.authorizer ?? preset?.authorizer;
    if (!authorizer) throw new SFieldError("INVALID_CONFIG", "authorizer is required without a preset", { path: "options.authorizer", suggestion: "Pass an Authorizer that answers action-on-resource questions (§9.2)" });
    if (persistence.mode !== deployment) {
      throw new SFieldError("UNSUPPORTED_DEPLOYMENT", `deployment ${deployment} needs a ${deployment} persistence backend; the supplied backend is ${persistence.mode}`, { path: "options.deployment" });
    }
    await checkLockApproved(config.digest, options.governance, deployment, { lockApprovals: persistence.lockApprovals, evalReports: persistence.evalReports });

    const ownerId = `${process.pid}:${newId("owner").slice(6, 14)}`;
    const namespace = options.namespace ?? configDir;
    await persistence.init({ namespace, ownerId });
    const artifacts = options.artifacts ?? preset?.artifacts ?? persistence.artifacts ?? new InMemoryArtifactStore();
    const memoryRepo = options.memory ?? preset?.memory ?? persistence.memory ?? new InMemoryMemoryRepository();
    const scrubber = new Scrubber(secrets.knownValues?.() ?? [], () => secrets.knownValues?.() ?? []);
    const bus = new EventBus(limits.eventRetention ? Math.min(limits.eventRetention, 5000) : 1000);
    const scheduler = new Scheduler(persistence, options.telemetry);
    const approvals = new ApprovalService({
      persistence,
      transport: options.approvals ?? preset?.approvals,
      inputTransport: options.input ?? preset?.input,
      approvalExpiryMs: (limits.approvalExpirySeconds ?? HOST_DEFAULTS.approvalExpirySeconds) * 1000,
      inputExpiryMs: (limits.inputExpirySeconds ?? HOST_DEFAULTS.inputExpirySeconds) * 1000,
      onWakeup: (runId) => void scheduler.wakeup(runId),
      preset: preset?.name,
    });
    const retentionDays = { preferences: limits.retention?.preferenceDays ?? 365, facts: limits.retention?.factDays ?? 30, conversation: limits.retention?.conversationDays ?? 30 };
    const memory = new MemoryService({ repository: memoryRepo, index: options.memoryIndex, artifacts, caps: { preferences: limits.memoryCaps?.preferences ?? HOST_DEFAULTS.memoryCaps.preferences, facts: limits.memoryCaps?.facts ?? HOST_DEFAULTS.memoryCaps.facts }, retentionDays, hooks: options.hooks, authorizer, audit: (r) => persistence.appendAudit(r), preset: preset?.name });

    // Bindings: shorthand models/connections/sources compile into the same binding objects as explicit host bindings (§5.5).
    const current = assembleVersion(config, options, plugins, secrets, configDir);
    const versions = new Map<string, ConfigVersion & { retrievalBindings: Map<string, RetrievalBinding> }>([[config.digest, current]]);
    const gateway = new ModelGateway({ providers: plugins.registrations.providers, secrets, telemetry: options.telemetry });
    const pipeline = new ToolPipeline({
      registry,
      persistence,
      authorizer,
      approvals,
      prerequisites: options.prerequisites ?? {},
      hooks: options.hooks ?? [],
      limits,
      connections: current.connections,
      artifacts,
      configDigest: config.digest,
      scrubber,
      reconciliation: options.reconciliation ?? {},
      preset: preset?.name,
      telemetry: options.telemetry,
      inlineResultLimitBytes: limits.inlineResultLimitBytes ?? HOST_DEFAULTS.inlineResultLimitBytes,
      modelViewLimitBytes: limits.modelViewLimitBytes ?? HOST_DEFAULTS.modelViewLimitBytes,
    });
    const runtime = new AgentRuntime({
      resolveVersion: (digest) => versions.get(digest),
      registry,
      persistence,
      pipeline,
      gateway,
      memory,
      approvals,
      bus,
      limits,
      hooks: options.hooks ?? [],
      scrubber,
      verifiers: options.verifiers ?? {},
      telemetry: options.telemetry,
      preset: preset?.name,
      ownerId,
      leaseMs: 30_000,
      hasInputTransport: approvals.hasInputTransport,
      registerAbort: (runId, controller) => scheduler.registerAbort(runId, controller),
    });
    (pipeline as unknown as { deps: { builtinExecutor: typeof runtime.builtinExecutor } }).deps.builtinExecutor = runtime.builtinExecutor;
    scheduler.attach(runtime);
    const devPrincipal = options.devPrincipal ?? preset?.devPrincipal;
    const instanceRef: { sf?: SField } = {};
    const runs = new RunService({ config: () => instanceRef.sf?.i.current.config ?? config, hasVersion: (digest) => versions.has(digest), persistence, scheduler, bus, registry, artifacts, requestMaxBytes: limits.requestMaxBytes ?? HOST_DEFAULTS.requestMaxBytes, idempotencyRetentionMs: (limits.retention?.idempotencyDays ?? HOST_DEFAULTS.idempotencyRetentionDays) * 86400000, preset: preset?.name, devPrincipal });
    const stopController = new AbortController();
    const hostBindings: HostBindings = { models: current.modelBindings, connections: current.connections, retrieval: Object.fromEntries(current.retrievalBindings) };
    plugins.checkRequirements(hostBindings, { secrets: () => true });
    await plugins.start({ config: config.extensions, bindings: hostBindings, secrets, signal: stopController.signal });
    if (preset && !options.quiet) {
      // eslint-disable-next-line no-console
      console.error(preset.banner ?? `[sfield] development preset "${preset.name}" — not for production`);
    }
    const sf = new SField({ options, versions, current, registry, plugins, persistence, artifacts, memory, approvals, pipeline, gateway, runtime, scheduler, bus, runs, secrets, scrubber, preset, deployment, limits, ownerId, devPrincipal, stopController });
    instanceRef.sf = sf;
    return sf;
  }

  /**
   * Reload (§20.2): compiles a candidate independently, checks governance and the lock, and switches new runs to it
   * atomically. Existing runs stay pinned to their version; an unapproved or invalid candidate leaves the running
   * configuration untouched.
   */
  async reload(input: { config?: string | JsonObject; overrides?: JsonObject[] } = {}): Promise<{ digest: string; previous: string; changed: boolean }> {
    const previous = this.i.current.config.digest;
    const options: SFieldCreateOptions = { ...this.i.options, config: input.config ?? this.i.options.config, overrides: input.overrides ?? this.i.options.overrides };
    const { loaded, ctx, configDir } = await prepareCompile(options, { validateOnly: true, registry: this.i.registry, plugins: this.i.plugins });
    const candidate = compileConfig(loaded, ctx);
    if (candidate.digest === previous) return { digest: previous, previous, changed: false };
    await checkLockApproved(candidate.digest, this.i.options.governance, this.i.deployment, { lockApprovals: this.i.persistence.lockApprovals, evalReports: this.i.persistence.evalReports });
    for (const t of Object.values(candidate.tools)) this.i.registry.registerConfigured(t);
    this.i.registry.verifyLock(candidate.lock);
    const version = assembleVersion(candidate, options, this.i.plugins, this.i.secrets, configDir);
    this.i.versions.set(candidate.digest, version);
    this.i.current = version;
    this.i.options = options;
    await this.i.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: "host", type: "config_reloaded", data: { previous, digest: candidate.digest }, preset: this.i.preset?.name }]);
    return { digest: candidate.digest, previous, changed: true };
  }

  // ------------------------------------------------------------ surfaces (§7.2)

  readonly sessions = {
    open: (input: { agent: string; principal?: Principal; conversationId?: string }): Promise<Session> => this.i.runs.openSession(input),
  };

  readonly runs = {
    start: (input: { agent: string; principal?: Principal; request: import("./types/common.js").SendRequest }): Promise<RunHandle> => this.i.runs.accept({ agentId: input.agent, principal: this.i.runs.resolvePrincipal(input.principal), request: input.request, kind: "standalone" }),
    get: (input: { runId: string; principal?: Principal }): Promise<RunHandle> => this.i.runs.get(input),
    resume: (input: { runId: string; principal?: Principal }): Promise<RunHandle> => this.i.runs.resume(input),
    snapshot: async (input: { runId: string; principal?: Principal }): Promise<RunSnapshot> => (await this.i.runs.get(input)).snapshot(),
    list: (filter: { tenantId?: string; conversationId?: string; limit?: number } = {}) => this.i.persistence.listRuns(filter),
  };

  readonly approvals = {
    decide: (input: { approvalId: string; actor: Actor; decision: "approve" | "deny"; comment?: string }): Promise<ApprovalRecord> => this.i.approvals.decide(input),
    list: (filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] } = {}): Promise<ApprovalRecord[]> => this.i.persistence.listApprovals(filter),
    get: (id: string): Promise<ApprovalRecord | null> => this.i.persistence.getApproval(id),
  };

  readonly inputs = {
    answer: (input: { requestId: string; actor: Actor; value: JsonValue }): Promise<InputRequestRecord> => this.i.approvals.answer(input),
    list: (filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] } = {}): Promise<InputRequestRecord[]> => this.i.persistence.listInputRequests(filter),
  };

  readonly executions = {
    open: async (input: Omit<ExecutionScopeOptions, "principal"> & { principal?: Principal }): Promise<ExecutionScope> => {
      const principal = this.i.runs.resolvePrincipal(input.principal);
      const scope = new ExternalExecutionScope({ config: this.i.current.config, persistence: this.i.persistence, registry: this.i.registry, pipeline: this.i.pipeline, approvals: this.i.approvals, bus: this.i.bus, ownerId: this.i.ownerId, leaseMs: 30_000, presetName: this.i.preset?.name }, { ...input, principal });
      return scope.open();
    },
  };

  readonly registry = {
    list: (): ToolDescription[] => this.i.registry.list().map((d) => this.i.registry.describe(d.ref)),
    describe: (ref: string): ToolDescription => this.i.registry.describe(ref),
    /** Direct execution without a model: an auditable execution scope is opened and closed around one call. */
    execute: async (input: { toolRef: string; inputs: JsonObject; principal?: Principal; preset?: "read_only" | "supervised" | "bounded_auto" }) => {
      const scope = await this.executions.open({ principal: input.principal, purpose: `direct:${input.toolRef}`, preset: input.preset });
      try {
        return await scope.registry.execute(input.toolRef, input.inputs);
      } finally {
        await scope.close();
      }
    },
  };

  readonly memory = {
    for: (principal?: Principal): MemoryHandle => this.i.memory.for(this.i.runs.resolvePrincipal(principal)),
  };

  readonly context = {
    /** Builds context for an external loop (§7.2). No model call is made. */
    build: async (input: { agent: string; principal?: Principal; message: import("./types/common.js").MessageInput; transcript?: import("./types/model.js").NeutralMessage[]; runInputs?: JsonObject }): Promise<ContextBuildOutput> => {
      const principal = this.i.runs.resolvePrincipal(input.principal);
      const agent = this.i.current.config.agents[input.agent];
      if (!agent) throw new SFieldError("UNKNOWN_AGENT", `agent ${input.agent} is not configured`);
      const binding = this.i.current.modelBindings[agent.model];
      if (!binding) throw new SFieldError("UNKNOWN_MODEL", `model ${agent.model} has no binding`);
      const capabilities = await this.i.gateway.describe(binding);
      const effective = computeEffectiveTools({ agent, registry: this.i.registry, limits: this.i.limits, hasInputTransport: this.i.approvals.hasInputTransport });
      const tools: ExposedTool[] = Object.entries(effective.aliases).map(([alias, ref]) => {
        const def = this.i.registry.get(ref)!;
        return { ref, alias, description: def.description, inputSchema: def.inputs, effect: def.policy.effect, requiresApproval: def.policy.requiresApproval, tokens: toolOverheadTokens({ alias, description: def.description, inputSchema: def.inputs }), builtin: def.source === "builtin" };
      });
      const scope = { kind: "subject" as const, tenantId: principal.tenantId, subjectId: principal.subjectId };
      const memory = {
        preferences: agent.memory.preferences === "explicit" ? await this.i.memory.listForContext(principal, scope, "preference", 50) : [],
        facts: agent.memory.facts === "explicit" ? await this.i.memory.listForContext(principal, scope, "fact", 50) : [],
        summaries: [],
      };
      const runId = newId("ctxrun");
      const out = await buildContext({ runId, agent, principal, message: input.message, runInputs: input.runInputs, attributes: principal.attributes, transcript: input.transcript ?? [], binding, capabilities, tools, memory, retrieval: this.i.current.retrieval });
      await this.i.persistence.saveContextExplanation(out.explanation);
      return out;
    },
    explain: async (input: { contextId: string; principal?: Principal }): Promise<ContextExplanation> => {
      const principal = this.i.runs.resolvePrincipal(input.principal);
      const rec = await this.i.persistence.getContextExplanation(input.contextId);
      if (!rec || rec.tenantId !== principal.tenantId) throw new SFieldError("NOT_FOUND", `context ${input.contextId} not found`);
      return rec;
    },
  };

  readonly conversations = {
    history: (input: { id: string; principal?: Principal; limit?: number }) => this.i.runs.history(input),
    export: (input: { id: string; principal?: Principal }) => this.i.runs.exportConversation(input),
    delete: (input: { id: string; principal?: Principal }) => this.i.runs.deleteConversation(input),
  };

  readonly config = {
    effective: (): EffectiveConfig => this.i.current.config,
    digest: (): string => this.i.current.config.digest,
    explain: (agent?: string) => explainConfig(this.i.current.config, agent),
    explainText: (agent?: string): string => formatExplanation(explainConfig(this.i.current.config, agent)),
    lock: () => this.i.current.config.lock,
    versions: (): string[] => [...this.i.versions.keys()],
  };

  readonly lock = {
    approve: (input: ApproveLockInput): Promise<{ record: LockApprovalRecord; changed: boolean }> => approveLock(input, this.i.options.governance, { lockApprovals: this.i.persistence.lockApprovals, evalReports: this.i.persistence.evalReports }),
    status: async (): Promise<{ digest: string; approved: LockApprovalRecord | null; required: boolean }> => ({ digest: this.i.current.config.digest, approved: await this.i.persistence.lockApprovals.get(this.i.current.config.digest), required: this.i.options.governance?.requireApproved ?? this.i.deployment === "service" }),
    evalReports: () => this.i.persistence.evalReports,
  };

  readonly audit = {
    read: (filter: { tenantId?: string; runId?: string; type?: string; limit?: number } = {}): Promise<AuditRecord[]> => this.i.persistence.readAudit(filter),
    calls: (runId: string) => this.i.persistence.listCalls(runId),
    modelAttempts: (runId: string) => this.i.persistence.listModelAttempts(runId),
    checkpoint: (runId: string) => this.i.persistence.getCheckpoint(runId),
    events: (runId: string, afterSeq = 0) => this.i.persistence.readEvents(runId, afterSeq),
  };

  /** Registers existing application code as a tool before the first run (§8.6). */
  registerTool(input: DefineToolInput): ToolDefinition {
    const def = this.i.registry.registerCode(input, "registerTool");
    return def;
  }

  get persistence(): ExecutionPersistence {
    return this.i.persistence;
  }

  get devPrincipal(): Principal | undefined {
    return this.i.devPrincipal;
  }

  get presetComponents(): Record<string, string> {
    return this.i.preset?.components ?? {};
  }

  async health(): Promise<HealthReport> {
    const persistence = await this.i.persistence.health();
    const plugins = await this.i.plugins.health();
    const degraded: string[] = [];
    for (const [id, h] of Object.entries(plugins)) if (!h.ok) degraded.push(`plugin:${id}`);
    for (const [id] of Object.entries(this.i.current.config.sources)) if (!this.i.current.retrieval.has(id)) degraded.push(`source:${id}`);
    const report: HealthReport = { ok: persistence.ok && degraded.length === 0 && !this.closed, deployment: this.i.deployment, configDigest: this.i.current.config.digest, degraded, plugins, persistence };
    if (this.i.preset) report.preset = this.i.preset.name;
    return report;
  }

  /** Stops admission, drains runtime-owned work up to drainMs, persists what it can, and releases resources (§20.2). */
  async close(opts: { drainMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.i.scheduler.drain(opts.drainMs ?? 5000);
    this.i.stopController.abort();
    await this.i.plugins.stop(AbortSignal.timeout(5000));
    await this.i.persistence.close();
  }
}

// ---------------------------------------------------------------- helpers

/** Builds the binding objects of one configuration version (§5.5, §6.3). */
function assembleVersion(config: EffectiveConfig, options: SFieldCreateOptions, plugins: PluginManager, secrets: SecretResolver, configDir: string): ConfigVersion & { retrievalBindings: Map<string, RetrievalBinding> } {
  const modelBindings: Record<string, ModelBinding> = {};
  for (const m of Object.values(config.models)) modelBindings[m.id] = m.form === "binding" ? options.bindings!.models![m.binding!]! : shorthandModelBinding(m);
  const connections: Record<string, ConnectionResolver> = { ...(options.bindings?.connections ?? {}) };
  for (const c of Object.values(config.connections)) connections[c.id] = shorthandConnection(c, secrets);
  const retrievalBindings = new Map<string, RetrievalBinding>();
  for (const s of Object.values(config.sources)) {
    if (s.form === "binding") retrievalBindings.set(s.id, options.bindings!.retrieval![s.binding!]!);
    else retrievalBindings.set(s.id, plugins.registrations.retrievalTypes.get(s.type!)!.create(s.id, s.config, { configDir }));
  }
  return { config, modelBindings, connections, retrieval: new RetrievalService(retrievalBindings), retrievalBindings };
}

async function prepareCompile(options: SFieldCreateOptions, mode: { validateOnly: boolean; registry?: ToolRegistry; plugins?: PluginManager }) {
  const env = options.env ?? process.env;
  if (options.preset && (env["NODE_ENV"] === "production" || options.deployment === "service")) {
    throw new SFieldError("PRESET_REFUSED", `development preset "${options.preset}" refuses to load ${env["NODE_ENV"] === "production" ? "under NODE_ENV=production" : "with deployment: service"}`, { suggestion: "Production configures persistence, identity, and authorization explicitly (§4.7)" });
  }
  let loaded: LoadedDocument;
  if (typeof options.config === "string") loaded = loadConfigFile(options.config);
  else loaded = loadConfigDocument(options.config, resolve(options.configDir ?? process.cwd()));
  const configDir = loaded.configDir;
  const reusing = !!mode.registry;
  const registry = mode.registry ?? new ToolRegistry();
  const plugins = mode.plugins ?? new PluginManager(registry);
  let preset: PresetComponents | undefined;
  if (!reusing) {
    plugins.registerProvider(new AnthropicProvider());
    plugins.registerProvider(new OpenAICompatibleProvider());
    let presetModule: PresetModule | undefined;
    if (options.preset) {
      presetModule = await loadPresetModule(options.preset, options.presetLoader);
      if (!mode.validateOnly) preset = await presetModule.createPreset({ ...options, configDir });
      for (const f of preset?.retrievalTypes ?? presetModule.retrievalTypes ?? []) if (!plugins.registrations.retrievalTypes.has(f.type)) plugins.registerRetrievalType(f);
    }
    for (const p of options.plugins ?? []) plugins.load(p);
    for (const t of options.tools ?? []) registry.registerCode(t, "bundle");
  }
  const deployment = options.deployment ?? preset?.deployment ?? (mode.validateOnly ? "ephemeral" : undefined);
  if (!deployment) throw new SFieldError("INVALID_CONFIG", "deployment is required without a preset", { path: "options.deployment", suggestion: 'Pass deployment: "durable_single" (or "ephemeral" for tests) with matching persistence' });
  const envSecrets = new EnvSecretResolver(env);
  const secrets: SecretResolver = options.secrets ? new CompositeSecretResolver(options.secrets, envSecrets) : (preset?.secrets ?? envSecrets);
  const limits: HostLimits = mergeLimits(preset?.limits, options.limits);
  const ctx: CompileContext = {
    registrations: {
      codeTools: registry.codeTools(),
      adapters: registry.adapterMap,
      providers: new Set(plugins.registrations.providers.keys()),
      retrievalTypes: plugins.registrations.retrievalTypes,
      verifiers: new Set(Object.keys(options.verifiers ?? {})),
      prerequisites: new Set(Object.keys(options.prerequisites ?? {})),
      contextTransforms: new Set(plugins.registrations.contextTransforms.keys()),
      plugins: plugins.registrations.manifests,
      reconciliation: new Set(Object.keys(options.reconciliation ?? {})),
    },
    bindings: {
      models: Object.fromEntries(Object.entries(options.bindings?.models ?? {}).map(([k, v]) => [k, v.identity])),
      connections: Object.fromEntries(Object.entries(options.bindings?.connections ?? {}).map(([k, v]) => [k, v.identity])),
      retrieval: Object.fromEntries(Object.entries(options.bindings?.retrieval ?? {}).map(([k, v]) => [k, v.identity])),
    },
    limits,
    env,
    overrides: options.overrides as JsonObject[] | undefined,
    checkCredentials: true,
    knownSecretNames: options.secrets ? () => true : undefined,
  };
  return { loaded, ctx, registry, plugins, preset, secrets, limits, deployment, configDir };
}

function mergeLimits(a?: HostLimits, b?: HostLimits): HostLimits {
  if (!a) return { ...(b ?? {}) };
  if (!b) return { ...a };
  const out: HostLimits = { ...a, ...b };
  if (a.grants || b.grants) out.grants = { ...(a.grants ?? {}), ...(b.grants ?? {}) };
  if (a.loopDetection || b.loopDetection) out.loopDetection = { ...(a.loopDetection ?? {}), ...(b.loopDetection ?? {}) };
  if (a.budgets || b.budgets) out.budgets = { ...(a.budgets ?? {}), ...(b.budgets ?? {}) };
  if (a.concurrency || b.concurrency) out.concurrency = { ...(a.concurrency ?? {}), ...(b.concurrency ?? {}) };
  if (a.memoryCaps || b.memoryCaps) out.memoryCaps = { ...(a.memoryCaps ?? {}), ...(b.memoryCaps ?? {}) };
  if (a.retention || b.retention) out.retention = { ...(a.retention ?? {}), ...(b.retention ?? {}) };
  if (a.revocations || b.revocations) out.revocations = { ...(a.revocations ?? {}), ...(b.revocations ?? {}) };
  return out;
}

async function loadPresetModule(name: string, loader?: (name: string) => Promise<PresetModule>): Promise<PresetModule> {
  if (loader) return loader(name);
  const pkg = `@sfield/preset-${name}`;
  let entry: string;
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    entry = req.resolve(pkg);
  } catch {
    throw new SFieldError("MISSING_PRESET", `preset "${name}" requires the package ${pkg}, which is not installed`, { suggestion: `npm install ${pkg}` });
  }
  const mod = (await import(pathToFileURL(entry).href)) as PresetModule & { default?: PresetModule };
  const create = mod.createPreset ?? mod.default?.createPreset;
  if (typeof create !== "function") throw new SFieldError("MISSING_PRESET", `${pkg} does not export createPreset`);
  return { createPreset: create, retrievalTypes: mod.retrievalTypes ?? mod.default?.retrievalTypes };
}

export function shorthandModelBinding(m: EffectiveModelConfig): ModelBinding {
  const provider = m.provider!;
  const defaults = PROVIDER_DEFAULT_LIMITS[provider] ?? { contextWindow: 32000, maxOutputTokens: 2048 };
  const binding: ModelBinding = {
    identity: shorthandIdentity("model", m.id, [provider, m.model!, m.base_url ?? ""], m.classification ?? "restricted"),
    provider,
    model: m.model!,
    acceptsClassification: m.classification ?? "restricted",
    limits: { contextWindow: m.limits?.context_window ?? defaults.contextWindow, maxOutputTokens: m.limits?.max_output_tokens ?? defaults.maxOutputTokens },
    params: m.params,
    supportedParams: PROVIDER_PARAMS[provider] ?? GENERIC_PARAMS,
  };
  if (m.credential) binding.credential = m.credential;
  if (m.base_url) binding.baseUrl = m.base_url;
  if (m.prices) binding.prices = { version: m.prices.version, inputPerMTok: m.prices.input_per_mtok, outputPerMTok: m.prices.output_per_mtok, cacheReadPerMTok: m.prices.cache_read_per_mtok, cacheWritePerMTok: m.prices.cache_write_per_mtok };
  if (m.quirks) binding.quirks = m.quirks as ModelBinding["quirks"];
  if (m.fallback) binding.fallback = m.fallback;
  if (m.api_version) binding.apiVersion = m.api_version;
  return binding;
}

export function shorthandConnection(c: EffectiveConnectionConfig, secrets: SecretResolver): ConnectionResolver {
  const identity = shorthandIdentity("connection", c.id, [c.base_url], c.classification);
  const config: JsonObject = { base_url: c.base_url, allowed_hosts: c.allowed_hosts, timeout_ms: c.timeout_ms, classification: c.classification, headers: (c.headers ?? {}) as JsonObject };
  return {
    identity,
    async resolve() {
      return {
        identity,
        config,
        material: async (): Promise<JsonObject> => (c.auth ? { auth: { type: c.auth.type, name: c.auth.name ?? null, value: await secrets.resolve(c.auth.credential) } } : {}),
      };
    },
  };
}

export { nowIso };
