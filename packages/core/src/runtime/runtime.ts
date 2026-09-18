/** Agent runtime (§14): the model–tool loop with durable state, suspension, recovery, budgets, and verification. */
import type { JsonObject, JsonValue, Principal } from "../types/common.js";
import { classificationAllowed } from "../types/common.js";
import type { EffectiveAgentConfig, EffectiveConfig } from "../config/types.js";
import type { MemoryItem } from "../types/memory.js";
import type { ModelAttemptRecord, ModelBinding, NeutralMessage, NeutralModelRequest, NeutralPart, NeutralToolResult, StopReason } from "../types/model.js";
import type { ConnectionResolver, HostLimits, RegisteredHook, TelemetrySink, Verifier } from "../types/options.js";
import type { BudgetScopeRequest, CallRecord, ExecutionPersistence, MessageRecord, OwnershipClaim, RunRecord } from "../types/persistence.js";
import type { Checkpoint, EffectSummary, RunCounters, RunEvent, RunState, UsageSummary } from "../types/runtime.js";
import { isTerminal } from "../types/runtime.js";
import type { AdapterResult, ExposedTool, ToolDefinition, ToolResult, ToolResultView } from "../types/tool.js";
import { SFieldError, sanitizeMessage } from "../errors.js";
import { digestJson, newId, nowIso } from "../util/digest.js";
import { Semaphore, withTimeout } from "../util/async.js";
import { periodKey } from "../util/clock.js";
import { Scrubber, StreamScanner } from "../util/scrub.js";
import { sharedValidator } from "../schema/validator.js";
import { HOST_DEFAULTS } from "../config/defaults.js";
import type { ToolRegistry } from "../registry/registry.js";
import { computeEffectiveTools } from "../registry/effective.js";
import { ASK_USER, MEMORY_FORGET, MEMORY_REMEMBER } from "../registry/builtins.js";
import { LoopDetector, callIdentity, emptyLoopState } from "../policy/loop-detector.js";
import type { ApprovalService } from "../policy/approvals.js";
import type { ToolPipeline, PreparedCall } from "../pipeline/execute.js";
import type { ModelGateway } from "../gateway/gateway.js";
import { estimateMaxCost } from "../gateway/pricing.js";
import { toolOverheadTokens } from "../gateway/providers/shared.js";
import type { MemoryService } from "../memory/service.js";
import type { RetrievalService } from "../retrieval/service.js";
import { buildContext } from "../context/builder.js";
import { estimateTokens } from "../util/tokens.js";
import type { EventBus } from "./events.js";

/** One loaded configuration version: runs stay pinned to the version they started with (§20.2). */
export interface ConfigVersion {
  config: EffectiveConfig;
  modelBindings: Record<string, ModelBinding>;
  connections: Record<string, ConnectionResolver>;
  retrieval: RetrievalService;
}

export interface RuntimeDeps {
  /** Resolves a pinned version by digest; undefined when its executable dependencies cannot be restored. */
  resolveVersion: (digest: string) => ConfigVersion | undefined;
  registry: ToolRegistry;
  persistence: ExecutionPersistence;
  pipeline: ToolPipeline;
  gateway: ModelGateway;
  memory: MemoryService;
  approvals: ApprovalService;
  bus: EventBus;
  limits: HostLimits;
  hooks: RegisteredHook[];
  scrubber: Scrubber;
  verifiers: Record<string, Verifier>;
  telemetry?: TelemetrySink;
  preset?: string;
  ownerId: string;
  leaseMs: number;
  hasInputTransport: boolean;
  /** Lets the scheduler abort in-flight work on cancel. */
  registerAbort: (runId: string, controller: AbortController) => void;
}

interface RunContext {
  run: RunRecord;
  version: ConfigVersion;
  agent: EffectiveAgentConfig;
  principal: Principal;
  claim: OwnershipClaim;
  cp: Checkpoint;
  controller: AbortController;
  effective: ReturnType<typeof computeEffectiveTools>;
  exposed: ExposedTool[];
  defsByAlias: Map<string, ToolDefinition>;
  loop: LoopDetector;
  activeStart: number;
  pendingApprovalResolvedEvents: RunEvent[];
}

type StepOutcome = "continue" | "parked" | "finished";

const MAX_HISTORY_MESSAGES = 60;

export class AgentRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  /** Executes a run from its durable state until it is terminal or durably parked. */
  async execute(runId: string): Promise<void> {
    const p = this.deps.persistence;
    const run0 = await p.getRun(runId);
    if (!run0) throw new SFieldError("NOT_FOUND", `run ${runId} not found`);
    if (isTerminal(run0.state)) return;
    const version = this.deps.resolveVersion(run0.configDigest);
    if (!version) {
      await this.finishWithoutOwnership(run0, "failed", { code: "RUN_NOT_RESUMABLE", message: `run is pinned to configuration ${run0.configDigest}, whose executable dependencies are no longer loaded` });
      return;
    }
    const agent = version.config.agents[run0.agentId];
    if (!agent) {
      await this.finishWithoutOwnership(run0, "failed", { code: "UNKNOWN_AGENT", message: `agent ${run0.agentId} is not in the pinned configuration` });
      return;
    }
    const claim = await p.claim(run0.scopeId, this.deps.ownerId, this.deps.leaseMs);
    if (!claim) throw new SFieldError("OWNERSHIP_UNAVAILABLE", `scope ${run0.scopeId} is owned by another executor`, { runId });
    const controller = new AbortController();
    this.deps.registerAbort(runId, controller);
    const renew = setInterval(() => {
      p.renew(claim, this.deps.leaseMs).then((c) => {
        if (!c) controller.abort(new SFieldError("OWNERSHIP_LOST", "lease lost", { runId }));
        else claim.expiresAt = c.expiresAt;
      }).catch(() => undefined);
    }, Math.max(1000, Math.floor(this.deps.leaseMs / 3)));
    renew.unref();
    try {
      const run = await p.updateRun(runId, claim.epoch, { wakeup: null, state: run0.state === "queued" ? "running" : run0.state, ownerId: this.deps.ownerId });
      const cp = (await p.getCheckpoint(runId)) ?? (await this.freshCheckpoint(run, agent, version));
      const principal = run.principal;
      const effective = computeEffectiveTools({ agent, registry: this.deps.registry, limits: this.deps.limits, hasInputTransport: this.deps.hasInputTransport });
      const defsByAlias = new Map<string, ToolDefinition>();
      const exposed: ExposedTool[] = [];
      for (const [alias, ref] of Object.entries(effective.aliases)) {
        const def = this.deps.registry.get(ref)!;
        defsByAlias.set(alias, def);
        exposed.push({ ref, alias, description: def.description, inputSchema: def.inputs, effect: def.policy.effect, requiresApproval: def.policy.requiresApproval, tokens: toolOverheadTokens({ alias, description: def.description, inputSchema: def.inputs }), builtin: def.source === "builtin" });
      }
      const ctx: RunContext = {
        run,
        version,
        agent,
        principal,
        claim,
        cp,
        controller,
        effective,
        exposed,
        defsByAlias,
        loop: new LoopDetector(agent.runtime.loop_detection, cp.loop),
        activeStart: Date.now(),
        pendingApprovalResolvedEvents: [],
      };
      if (run0.state === "queued") {
        await this.emit(ctx, "run_started", { agentId: agent.id, configDigest: run.configDigest, tools: exposed.map((t) => t.ref), excluded: effective.excluded.map((e) => `${e.ref}:${e.reason}`) });
      } else {
        await this.emit(ctx, "run_resumed", { from: run0.state, reason: run0.wakeup?.reason ?? "resume" });
        await p.updateRun(runId, claim.epoch, { state: "running" });
      }
      await this.loop(ctx);
    } catch (err) {
      const e = SFieldError.from(err);
      const current = await p.getRun(runId);
      if (current && !isTerminal(current.state) && e.code !== "OWNERSHIP_LOST") {
        try {
          await this.finish({ run: current, claim } as RunContext, e.code === "CANCELLED" ? "cancelled" : "failed", undefined, e);
        } catch {
          // ownership may be gone; the successor owns the persisted run
        }
      }
      if (e.code === "OWNERSHIP_LOST") return;
    } finally {
      clearInterval(renew);
      await p.release(claim).catch(() => undefined);
      this.deps.bus.end(runId);
    }
  }

  private async freshCheckpoint(run: RunRecord, agent: EffectiveAgentConfig, version: ConfigVersion): Promise<Checkpoint> {
    const transcript: NeutralMessage[] = [];
    if (run.conversationId && agent.memory.conversation) {
      const messages = await this.deps.persistence.listMessages(run.conversationId, { limit: MAX_HISTORY_MESSAGES });
      for (const m of messages) {
        if (m.runId === run.runId && m.role === "user") continue; // current message
        const neutral = messageToNeutral(m);
        if (neutral) transcript.push(neutral);
      }
      // Drop a leading orphan tool_results and a trailing assistant call batch without results.
      while (transcript[0]?.role === "tool_results") transcript.shift();
      const last = transcript[transcript.length - 1];
      if (last?.role === "assistant" && last.parts.some((pt) => pt.type === "tool_call")) transcript.pop();
    }
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      agentId: agent.id,
      configDigest: run.configDigest,
      pluginIdentities: Object.fromEntries(Object.entries(version.config.lock.plugins).map(([k, v]) => [k, v.buildDigest])),
      transcript,
      runMessages: [],
      contextPacketIds: [],
      pendingApprovals: [],
      pendingInputs: [],
      reservationIds: [],
      counters: { turns: 0, modelCalls: 0, providerAttempts: 0, toolCalls: 0, toolAttempts: 0, inputTokens: 0, outputTokens: 0, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 0, repairs: 0, summarizations: 0, polls: 0, contextRefits: 0, continuations: 0 },
      loop: emptyLoopState(),
      batchResults: {},
      startedAt: run.createdAt,
      updatedAt: nowIso(),
    };
  }

  // ---------------------------------------------------------------- main loop

  private async loop(ctx: RunContext): Promise<void> {
    const { agent, cp } = ctx;
    let modelId = agent.model;
    let inputCeiling = agent.context.max_input_tokens;
    while (true) {
      const stop = await this.checkBoundaries(ctx);
      if (stop) return;
      if (cp.pendingBatch) {
        const outcome = await this.runBatch(ctx, cp.pendingBatch.callIds, true);
        if (outcome !== "continue") return;
        continue;
      }
      if (cp.counters.turns >= agent.budget.max_turns) {
        await this.finish(ctx, "budget_exhausted", undefined, new SFieldError("BUDGET_EXHAUSTED", `max_turns ${agent.budget.max_turns} reached`));
        return;
      }
      cp.counters.turns++;
      const turnStart = Date.now();
      let dispatch: Awaited<ReturnType<typeof this.modelTurn>>;
      try {
        dispatch = await this.modelTurn(ctx, modelId, inputCeiling);
      } catch (err) {
        const e = SFieldError.from(err);
        if (e.code === "CONTEXT_LIMIT" && cp.counters.contextRefits < 1) {
          cp.counters.contextRefits++;
          inputCeiling = Math.floor(inputCeiling * 0.75);
          await this.emit(ctx, "context_refit", { reason: e.message, newCeiling: inputCeiling });
          cp.counters.turns--;
          continue;
        }
        if (e.code === "REQUIRED_CONTEXT_UNAVAILABLE" || e.code === "CONTEXT_LIMIT" || e.code === "CLASSIFICATION_DENIED") {
          await this.finish(ctx, "failed", undefined, e);
          return;
        }
        if (e.code === "CANCELLED") {
          await this.finish(ctx, "cancelled", undefined, e);
          return;
        }
        if (e.code === "BUDGET_EXHAUSTED") {
          await this.finish(ctx, "budget_exhausted", undefined, e);
          return;
        }
        // Provider failure: explicit fallback when configured and compatible (§13.4).
        const fallback = ctx.version.config.models[modelId]?.fallback;
        if (fallback && fallback !== modelId && this.fallbackCompatible(ctx, modelId, fallback)) {
          await this.emit(ctx, "model_fallback", { from: modelId, to: fallback, reason: e.code });
          modelId = fallback;
          cp.counters.turns--;
          continue;
        }
        await this.finish(ctx, "failed", undefined, e);
        return;
      } finally {
        cp.counters.activeMs += Date.now() - turnStart;
      }
      const { message, stopReason } = dispatch;
      cp.runMessages.push(message);
      await this.persistMessage(ctx, "assistant", message.parts as unknown as JsonValue);
      await this.checkpoint(ctx);
      const budgetStop = await this.checkBudgets(ctx);
      if (budgetStop) return;

      switch (stopReason) {
        case "tool_use": {
          const calls = message.parts.filter((pt): pt is Extract<NeutralPart, { type: "tool_call" }> => pt.type === "tool_call");
          if (calls.length === 0) {
            await this.finish(ctx, "failed", undefined, new SFieldError("INCOMPLETE_OUTPUT", "model signaled tool use without a complete tool call"));
            return;
          }
          const outcome = await this.runBatch(ctx, calls.map((c) => c.callId), false);
          if (outcome !== "continue") return;
          break;
        }
        case "end_turn":
        case "stop_sequence": {
          const done = await this.complete(ctx, message);
          if (done !== "continue") return;
          break;
        }
        case "continue":
          break;
        case "max_tokens":
          // One bounded continuation of the assistant turn (§13.3); no fabricated user message.
          if (cp.counters.continuations < 1 && !message.parts.some((pt) => pt.type === "tool_call") && !agent.output.schema) {
            cp.counters.continuations++;
            await this.emit(ctx, "output_continuation", { reason: "max_tokens" });
            break;
          }
          await this.finish(ctx, "failed", undefined, new SFieldError("INCOMPLETE_OUTPUT", "model output truncated by the output token limit"));
          return;
        case "refusal":
          await this.finish(ctx, "refused", textOf(message));
          return;
        case "content_filter":
          await this.finish(ctx, "filtered", undefined, new SFieldError("CONTENT_FILTERED", "provider content filter stopped the response"));
          return;
        case "context_exceeded":
          if (cp.counters.contextRefits < 1) {
            cp.counters.contextRefits++;
            inputCeiling = Math.floor(inputCeiling * 0.75);
            cp.runMessages.pop();
            break;
          }
          await this.finish(ctx, "failed", undefined, new SFieldError("CONTEXT_LIMIT", "provider reported the context window exceeded"));
          return;
        default:
          await this.finish(ctx, "failed", undefined, new SFieldError("PROVIDER_UNAVAILABLE", `unexpected stop reason ${String(stopReason)}`));
          return;
      }
    }
  }

  private fallbackCompatible(ctx: RunContext, from: string, to: string): boolean {
    const target = ctx.version.modelBindings[to];
    if (!target) return false;
    // Data routing: the fallback must accept at least what the primary accepted; opaque blocks must be convertible.
    const primary = ctx.version.modelBindings[from];
    if (primary && !classificationAllowed(primary.acceptsClassification, target.acceptsClassification)) return false;
    if ([...ctx.cp.transcript, ...ctx.cp.runMessages].some((m) => m.role !== "tool_results" && m.parts.some((pt) => pt.type === "opaque" && pt.provider !== target.provider))) return false;
    return true;
  }

  private async checkBoundaries(ctx: RunContext): Promise<boolean> {
    const run = await this.deps.persistence.getRun(ctx.run.runId);
    if (run?.cancelRequested) {
      ctx.controller.abort(new SFieldError("CANCELLED", run.cancelRequested.reason ?? "cancelled"));
      await this.finish(ctx, "cancelled", undefined, new SFieldError("CANCELLED", run.cancelRequested.reason ?? "cancelled by caller"));
      return true;
    }
    if (run && Date.parse(run.expiresAt) <= Date.now()) {
      await this.finish(ctx, "expired", undefined, new SFieldError("BUDGET_EXHAUSTED", "run expired (max_elapsed_seconds)"));
      return true;
    }
    const activeMs = ctx.cp.counters.activeMs;
    if (activeMs > ctx.agent.budget.max_active_seconds * 1000) {
      await this.finish(ctx, "budget_exhausted", undefined, new SFieldError("BUDGET_EXHAUSTED", `max_active_seconds ${ctx.agent.budget.max_active_seconds} exceeded`));
      return true;
    }
    return false;
  }

  private async checkBudgets(ctx: RunContext): Promise<boolean> {
    const { counters } = ctx.cp;
    const b = ctx.agent.budget;
    const total = counters.inputTokens + counters.outputTokens;
    const reasons: string[] = [];
    if (total > b.max_tokens) reasons.push(`max_tokens ${b.max_tokens} exceeded (${total}${counters.tokensReported ? "" : ", estimated"})`);
    if (counters.costMicroUsd > b.max_cost_microusd) reasons.push(`max_cost_microusd ${b.max_cost_microusd} exceeded (${counters.costMicroUsd}, ${counters.costLabel})`);
    if (counters.modelCalls > b.max_model_calls) reasons.push(`max_model_calls ${b.max_model_calls} exceeded`);
    if (reasons.length) {
      await this.finish(ctx, "budget_exhausted", undefined, new SFieldError("BUDGET_EXHAUSTED", reasons.join("; ")));
      return true;
    }
    if (total > b.max_tokens * 0.8 || counters.costMicroUsd > b.max_cost_microusd * 0.8 || counters.turns >= b.max_turns * 0.8) {
      if (!ctx.cp.batchResults["__budget_warned"]) {
        await this.emit(ctx, "budget_warning", { tokens: total, costMicroUsd: counters.costMicroUsd, turns: counters.turns });
        ctx.cp.batchResults["__budget_warned"] = { callId: "__budget_warned", toolRef: "", status: "succeeded", effect: "none", meta: { attempts: 0, durationMs: 0, bytes: 0 } };
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- model turn

  private async modelTurn(ctx: RunContext, modelId: string, inputCeiling: number): Promise<{ message: Extract<NeutralMessage, { role: "assistant" }>; stopReason: StopReason }> {
    const { agent, cp, principal, run } = ctx;
    const binding = ctx.version.modelBindings[modelId];
    if (!binding) throw new SFieldError("UNKNOWN_MODEL", `model ${modelId} has no binding`);
    const capabilities = await this.deps.gateway.describe(binding);
    if (cp.counters.modelCalls >= agent.budget.max_model_calls) throw new SFieldError("BUDGET_EXHAUSTED", `max_model_calls ${agent.budget.max_model_calls} reached`);
    const memory = await this.loadMemory(ctx);
    const ctxStart = Date.now();
    const built = await buildContext({
      runId: run.runId,
      agent: { ...agent, context: { ...agent.context, max_input_tokens: inputCeiling } },
      principal,
      message: run.request.message,
      runInputs: run.request.inputs,
      attributes: principal.attributes,
      transcript: cp.transcript,
      continuation: cp.runMessages,
      binding,
      capabilities,
      tools: ctx.exposed,
      memory,
      retrieval: ctx.version.retrieval,
      signal: ctx.controller.signal,
      countTokens: capabilities.tokenCounting === "provider" ? (req) => this.deps.gateway.countTokens(req) : undefined,
    });
    this.deps.telemetry?.metric?.("sfield.context.build_ms", Date.now() - ctxStart, { agent: agent.id });
    this.deps.telemetry?.metric?.("sfield.context.omissions", built.packet.omissions.length, { agent: agent.id });
    await this.deps.persistence.saveContextExplanation(built.explanation);
    cp.contextPacketIds.push(built.packet.id);
    await this.emit(ctx, "context_built", { contextId: built.packet.id, blocks: built.packet.blocks.length, omissions: built.packet.omissions.length, estimatedInput: built.packet.budget.estimatedInput, estimated: built.packet.budget.estimated, tools: built.packet.tools.length, digest: built.packet.digest });
    if (run.kind === "session") ctx.run.citations = Object.fromEntries(Object.entries(built.packet.citations).map(([k, v]) => [k, { label: v.label, uri: v.uri, locator: v.locator }]));
    else ctx.run.citations = Object.fromEntries(Object.entries(built.packet.citations).map(([k, v]) => [k, { label: v.label, uri: v.uri, locator: v.locator }]));

    let request: NeutralModelRequest = built.request;
    for (const hook of this.deps.hooks) {
      if (hook.point !== "beforeModelDispatch" || !hook.beforeModelDispatch) continue;
      try {
        const res = await withTimeout(hook.timeoutMs, () => hook.beforeModelDispatch!({ request, runId: run.runId }), { label: `hook ${hook.id}` });
        if (res?.request) {
          // A hook may only narrow: fewer tools, shorter instructions; never add tools (§23.3).
          const allowed = new Set(request.tools.map((t) => t.ref));
          if (res.request.tools.some((t) => !allowed.has(t.ref))) throw new SFieldError("ACCESS_DENIED", `hook ${hook.id} attempted to grant tools`);
          request = { ...res.request, binding: request.binding };
        }
      } catch (e) {
        if (SFieldError.is(e, "ACCESS_DENIED")) throw e;
        if (hook.onFailure === "fail") throw new SFieldError("HOOK_TIMEOUT", `hook ${hook.id} failed: ${(e as Error).message}`);
      }
    }
    cp.counters.modelCalls++;
    const scanner = new StreamScanner(this.deps.scrubber);
    const stream = agent.output.stream;
    const scopes = this.budgetScopes(ctx);
    const result = await this.deps.gateway.dispatch(request, {
      runId: run.runId,
      signal: ctx.controller.signal,
      beginAttempt: async () => {
        if (cp.counters.providerAttempts >= agent.budget.max_provider_attempts) return null;
        const estimate = estimateMaxCost(built.packet.budget.estimatedInput, request.params.maxOutputTokens, binding.prices);
        const res = await this.deps.persistence.reserve({ runId: run.runId, tenantId: principal.tenantId, subjectId: principal.subjectId, kind: "model", estimateMicroUsd: estimate, estimateTokens: built.packet.budget.estimatedInput + request.params.maxOutputTokens, priceVersion: binding.prices?.version, scopes: scopes.map((s) => s.key) }, scopes);
        if (!res.ok) throw new SFieldError("BUDGET_EXHAUSTED", res.reason);
        cp.counters.providerAttempts++;
        cp.reservationIds.push(res.id);
        return { attemptId: `${res.id}:att${cp.counters.providerAttempts}` };
      },
      onAttempt: async (rec: ModelAttemptRecord) => {
        await this.deps.persistence.recordModelAttempt(run.runId, rec);
        const reservationId = rec.attemptId.split(":")[0]!;
        if (rec.status === "succeeded" && rec.usage) {
          await this.deps.persistence.settle(reservationId, rec.costMicroUsd ?? 0, "settled");
          cp.counters.inputTokens += rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
          cp.counters.outputTokens += rec.usage.outputTokens;
          if (!rec.usage.reported) cp.counters.tokensReported = false;
          cp.counters.costMicroUsd += rec.costMicroUsd ?? 0;
          const label = binding.prices ? (rec.usage.reported ? "priced" : "best_effort") : "unpriced";
          cp.counters.costLabel = cp.counters.costLabel === "unpriced" || cp.counters.costLabel === label ? label : "best_effort";
        } else {
          // Usage unknown: the reservation stays held/uncertain until reconciliation (§15.3).
          await this.deps.persistence.settle(reservationId, 0, rec.status === "cancelled" ? "uncertain" : "uncertain");
        }
        await this.deps.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, runId: run.runId, type: "model_attempt", principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, configDigest: run.configDigest, data: { attemptId: rec.attemptId, model: rec.model, status: rec.status, stopReason: rec.stopReason ?? null, usage: (rec.usage as unknown as JsonObject) ?? null, costMicroUsd: rec.costMicroUsd ?? null, compiledDigest: rec.compiledDigest, contextId: built.packet.id, error: rec.error ? { code: rec.error.code } : null }, preset: this.deps.preset }]);
      },
      onDelta: stream ? (t) => {
        const safe = scanner.feed(t);
        if (safe) this.deps.bus.publish([{ v: 1, id: newId("evt"), runId: run.runId, conversationId: run.conversationId, timestamp: nowIso(), type: "text_delta", payload: { text: safe }, provisional: true }]);
      } : undefined,
      onReset: () => this.deps.bus.publish([{ v: 1, id: newId("evt"), runId: run.runId, conversationId: run.conversationId, timestamp: nowIso(), type: "generation_reset", payload: {}, provisional: true }]),
    });
    const tail = scanner.flush();
    if (stream && tail) this.deps.bus.publish([{ v: 1, id: newId("evt"), runId: run.runId, conversationId: run.conversationId, timestamp: nowIso(), type: "text_delta", payload: { text: tail }, provisional: true }]);
    // Bind provider tool calls to stable logical call ids and registry refs.
    const message = result.message;
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      part.callId = newId("call");
      part.toolRef = result.compiled.aliasMap[part.alias] ?? "";
    }
    let stopReason = result.stopReason;
    if (stopReason === "stop_sequence" && result.stopSequence !== undefined) {
      await this.deps.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, runId: run.runId, type: "stop_sequence", principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, data: { stopSequence: result.stopSequence } }]);
    }
    if (stopReason === "end_turn" && message.parts.some((pt) => pt.type === "tool_call")) stopReason = "tool_use";
    return { message, stopReason };
  }

  private async loadMemory(ctx: RunContext): Promise<{ preferences: MemoryItem[]; facts: MemoryItem[]; summaries: MemoryItem[] }> {
    const { agent, principal, run } = ctx;
    const scope = { kind: "subject" as const, tenantId: principal.tenantId, subjectId: principal.subjectId };
    const out: { preferences: MemoryItem[]; facts: MemoryItem[]; summaries: MemoryItem[] } = { preferences: [], facts: [], summaries: [] };
    if (run.kind !== "session") return out;
    if (agent.memory.preferences === "explicit") out.preferences = await this.deps.memory.listForContext(principal, scope, "preference", 50).catch(() => []);
    if (agent.memory.facts === "explicit") out.facts = await this.deps.memory.listForContext(principal, scope, "fact", 50).catch(() => []);
    if (run.conversationId) out.summaries = await this.deps.memory.listForContext(principal, { kind: "conversation", tenantId: principal.tenantId, conversationId: run.conversationId }, "summary", 3).catch(() => []);
    return out;
  }

  private budgetScopes(ctx: RunContext): BudgetScopeRequest[] {
    const { agent, principal, run } = ctx;
    const scopes: BudgetScopeRequest[] = [{ key: JSON.stringify(["run", run.runId]), ceilingMicroUsd: agent.budget.max_cost_microusd }];
    const b = this.deps.limits.budgets;
    if (b?.subjectPeriodCostMicroUsd !== undefined) scopes.push({ key: JSON.stringify(["subject", principal.tenantId, principal.subjectId, periodKey(new Date(), b.period ?? "day")]), ceilingMicroUsd: b.subjectPeriodCostMicroUsd });
    if (b?.tenantPeriodCostMicroUsd !== undefined) scopes.push({ key: JSON.stringify(["tenant", principal.tenantId, periodKey(new Date(), b.period ?? "day")]), ceilingMicroUsd: b.tenantPeriodCostMicroUsd });
    return scopes;
  }

  // ---------------------------------------------------------------- tool batches

  private async runBatch(ctx: RunContext, callIds: string[], resuming: boolean): Promise<StepOutcome> {
    const { cp, agent, principal, run, claim } = ctx;
    const p = this.deps.persistence;
    const last = cp.runMessages[cp.runMessages.length - 1];
    if (!last || last.role !== "assistant") throw new SFieldError("STATE_UNAVAILABLE", "batch without an assistant call message");
    const calls = last.parts.filter((pt): pt is Extract<NeutralPart, { type: "tool_call" }> => pt.type === "tool_call" && callIds.includes(pt.callId));
    const batchId = cp.pendingBatch?.batchId ?? newId("batch");
    const turn = cp.pendingBatch?.turn ?? cp.counters.turns;
    if (!resuming) {
      if (cp.counters.toolCalls + calls.length > agent.budget.max_tool_calls) {
        await this.finish(ctx, "budget_exhausted", undefined, new SFieldError("BUDGET_EXHAUSTED", `max_tool_calls ${agent.budget.max_tool_calls} would be exceeded`));
        return "finished";
      }
      cp.counters.toolCalls += calls.length;
      const records: CallRecord[] = calls.map((c, order) => ({ callId: c.callId, runId: run.runId, batchId, turn, order, toolRef: c.toolRef || c.alias, state: "proposed", proposedArguments: c.arguments, providerCallId: c.providerCallId, attempts: [], createdAt: nowIso(), updatedAt: nowIso() }));
      await p.prepareBatch(run.runId, claim.epoch, records);
      cp.pendingBatch = { batchId, callIds: calls.map((c) => c.callId), turn };
      cp.batchResults = {};
      await this.checkpoint(ctx);
    }
    const results: Record<string, { result: ToolResult; view: ToolResultView }> = {};
    for (const [id, r] of Object.entries(cp.batchResults)) if (!id.startsWith("__")) results[id] = { result: r, view: this.deps.pipeline.modelView(r) };

    // Prepare every call that has no result yet; recover calls interrupted mid-dispatch.
    const prepared = new Map<string, PreparedCall>();
    const existing = new Map((await p.listCalls(run.runId)).map((c) => [c.callId, c]));
    for (const call of calls) {
      if (results[call.callId]) continue;
      const rec = existing.get(call.callId);
      if (rec && (rec.state === "intent_committed" || rec.state === "dispatched" || rec.state === "outcome_unknown" || rec.state === "succeeded" || rec.state === "failed")) {
        const recovered = await this.deps.pipeline.recover(rec, principal, ctx.controller.signal);
        results[call.callId] = { result: recovered.result, view: this.deps.pipeline.modelView(recovered.result) };
        cp.batchResults[call.callId] = recovered.result;
        // The recovered outcome is durable evidence: record it on the call and settle its reservation (§16.4).
        if (rec.state !== "succeeded" && rec.state !== "failed") {
          const state = recovered.result.status === "succeeded" ? "succeeded" : recovered.result.status === "failed" ? "failed" : "outcome_unknown";
          await p.commitResult({ runId: run.runId, epoch: claim.epoch, callId: call.callId, result: recovered.result, state, reservation: rec.reservationId ? { id: rec.reservationId, actualMicroUsd: 0, state: state === "outcome_unknown" ? "uncertain" : "settled" } : undefined, events: [{ v: 1, id: newId("evt"), runId: run.runId, conversationId: run.conversationId, timestamp: nowIso(), type: "tool_recovered", payload: { callId: call.callId, toolRef: rec.toolRef, status: recovered.result.status, effect: recovered.result.effect, resolved: recovered.resolved } }], audit: [{ id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, runId: run.runId, callId: call.callId, type: "tool_recovered", principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, configDigest: run.configDigest, data: { fromState: rec.state, status: recovered.result.status, effect: recovered.result.effect, resolved: recovered.resolved }, preset: this.deps.preset }] });
        }
        if (!recovered.resolved) {
          await this.park(ctx, "reconciliation_required", { reason: "reconciliation", note: `call ${call.callId} has an unresolved external effect` });
          return "parked";
        }
        continue;
      }
      const def = ctx.defsByAlias.get(call.alias) ?? (call.toolRef ? this.deps.registry.get(call.toolRef) : undefined);
      if (!def || (def.source !== "builtin" && !ctx.effective.business.some((d) => d.ref === def.ref)) || (def.source === "builtin" && !ctx.effective.builtins.some((d) => d.ref === def.ref))) {
        results[call.callId] = this.errorResult(call.callId, call.toolRef || call.alias, "UNKNOWN_TOOL", `tool ${call.alias} is not available`);
        await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected", result: results[call.callId]!.result });
        continue;
      }
      if ("_invalid" in call.arguments) {
        results[call.callId] = this.errorResult(call.callId, def.ref, "INVALID_INPUT", "tool arguments were not valid JSON");
        await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected", result: results[call.callId]!.result });
        continue;
      }
      try {
        const pc = await this.deps.pipeline.prepare({ def, inputs: call.arguments, principal, runId: run.runId, callId: call.callId, agentId: agent.id, preset: agent.policy.preset, configDigest: run.configDigest, connections: ctx.version.connections });
        // Repeated-call detection on the resolved identity (§14.7).
        const identity = callIdentity(def.ref, digestJson(pc.normalizedInputs), pc.invocation.resource.id);
        const verdict = ctx.loop.check({ identity, effect: def.policy.effect, pollable: def.policy.pollable, turn, now: Date.now(), callId: call.callId });
        if (verdict.action === "fail") {
          await this.audit(ctx, "loop_detected", { identity, earlier: verdict.earlier, callId: call.callId });
          await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected" });
          await this.finish(ctx, "failed", undefined, new SFieldError("LOOP_DETECTED", `tool ${def.ref} repeated with identical arguments (earlier call ${verdict.earlier.callId}, turn ${verdict.earlier.turn})`));
          return "finished";
        }
        if (verdict.action === "warn") {
          ctx.loop.record(identity, turn, call.callId, Date.now(), { warned: true });
          await this.audit(ctx, "loop_warning", { identity, earlier: verdict.earlier, callId: call.callId });
          const earlierResult = cp.batchResults[verdict.earlier.callId] ?? existing.get(verdict.earlier.callId)?.result;
          results[call.callId] = this.errorResult(call.callId, def.ref, "REPEATED_CALL", `identical to earlier call ${verdict.earlier.callId} in turn ${verdict.earlier.turn}; reuse its result${earlierResult?.outputRef ? ` (artifact ${earlierResult.outputRef.id})` : ""} instead of repeating the call`);
          await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected", result: results[call.callId]!.result });
          continue;
        }
        ctx.loop.record(identity, turn, call.callId, Date.now(), { poll: verdict.poll });
        if (verdict.poll) cp.counters.polls++;
        prepared.set(call.callId, pc);
        await p.updateCall(run.runId, claim.epoch, call.callId, { state: "prepared", invocation: pc.invocation });
        await this.emit(ctx, "tool_prepared", { callId: call.callId, toolRef: def.ref, effect: def.policy.effect, resource: pc.invocation.resource, approvalRequired: pc.approval.required, digest: pc.invocation.digest });
      } catch (err) {
        const e = SFieldError.from(err);
        if (e.code === "CANCELLED" || e.code === "OWNERSHIP_LOST") throw e;
        results[call.callId] = this.errorResult(call.callId, def.ref, e.code, e.message);
        await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected", result: results[call.callId]!.result });
      }
    }

    // Suspend the whole batch before any member dispatches when approval or input is needed (§14.2 step 6).
    const needingApproval = [...prepared.values()].filter((pc) => pc.approval.required);
    const approvalIds = new Map<string, string>();
    if (needingApproval.length) {
      const outcome = await this.collectApprovals(ctx, needingApproval, approvalIds);
      if (outcome !== "continue") return outcome;
    }
    const needingInput = [...prepared.values()].filter((pc) => inputRequirement(pc.def, pc.normalizedInputs));
    if (needingInput.length) {
      const outcome = await this.collectInputs(ctx, needingInput);
      if (outcome !== "continue") return outcome;
    }

    // 7-8. Reads concurrently up to the limit; mutations sequentially in model order.
    const readLimit = this.deps.limits.concurrency?.readsPerRun ?? HOST_DEFAULTS.concurrency.readsPerRun;
    const sem = new Semaphore(Math.max(1, readLimit));
    const scopes = this.budgetScopes(ctx);
    let mutationHalted = false;
    const dispatchOne = async (pc: PreparedCall): Promise<void> => {
      const out = await this.deps.pipeline.dispatch({ prepared: pc, principal, runId: run.runId, epoch: claim.epoch, agentId: agent.id, conversationId: run.conversationId, approvalId: approvalIds.get(pc.invocation.callId), signal: ctx.controller.signal, budgetScopes: scopes, connections: ctx.version.connections, onEvents: (evs) => this.deps.bus.publish(evs) });
      cp.counters.toolAttempts += out.result.meta.attempts;
      results[pc.invocation.callId] = { result: out.result, view: out.view };
      cp.batchResults[pc.invocation.callId] = out.result;
    };
    const readTasks: Promise<void>[] = [];
    for (const call of calls) {
      const pc = prepared.get(call.callId);
      if (!pc) continue;
      if (pc.def.policy.effect === "read") {
        readTasks.push(sem.acquire().then((release) => dispatchOne(pc).finally(release)));
      }
    }
    await Promise.all(readTasks);
    for (const call of calls) {
      const pc = prepared.get(call.callId);
      if (!pc || pc.def.policy.effect === "read") continue;
      if (mutationHalted) {
        results[call.callId] = this.errorResult(call.callId, pc.def.ref, "RECONCILIATION_REQUIRED", "not dispatched: an earlier mutation in this batch has an unresolved outcome");
        await p.updateCall(run.runId, claim.epoch, call.callId, { state: "rejected", result: results[call.callId]!.result });
        cp.batchResults[call.callId] = results[call.callId]!.result;
        continue;
      }
      await dispatchOne(pc);
      if (results[call.callId]!.result.status === "outcome_unknown") mutationHalted = true;
      if (cp.counters.toolAttempts > agent.budget.max_tool_attempts) {
        await this.finish(ctx, "budget_exhausted", undefined, new SFieldError("BUDGET_EXHAUSTED", `max_tool_attempts ${agent.budget.max_tool_attempts} exceeded`));
        return "finished";
      }
    }
    await this.checkpoint(ctx);
    if (mutationHalted) {
      await this.park(ctx, "reconciliation_required", { reason: "reconciliation", note: "a mutation has an unresolved external effect" });
      return "parked";
    }

    // 9. Append the complete result group in original model order.
    const group: NeutralToolResult[] = calls.map((c) => {
      const r = results[c.callId]!;
      return { callId: c.callId, alias: c.alias, providerCallId: c.providerCallId, content: r.view.content, isError: r.view.isError };
    });
    cp.runMessages.push({ role: "tool_results", results: group });
    await this.persistMessage(ctx, "tool_results", group as unknown as JsonValue);
    delete cp.pendingBatch;
    cp.batchResults = {};
    await this.checkpoint(ctx);
    return "continue";
  }

  private async collectApprovals(ctx: RunContext, needing: PreparedCall[], approvalIds: Map<string, string>): Promise<StepOutcome> {
    const { cp, run, principal, agent, claim } = ctx;
    const p = this.deps.persistence;
    // Reuse a pending/decided approval from a previous execution of this batch.
    let approval = cp.pendingApprovals.length ? await p.getApproval(cp.pendingApprovals[0]!) : null;
    const digests = needing.map((pc) => pc.invocation.digest);
    if (approval && (approval.preparedDigests.join(",") !== digests.join(",") || approval.status === "expired")) approval = null;
    if (!approval) {
      approval = await this.deps.approvals.create({ runId: run.runId, tenantId: principal.tenantId, requesterSubjectId: principal.subjectId, agentId: agent.id, invocations: needing.map((pc) => pc.invocation), views: needing.map((pc) => pc.view) });
      for (const pc of needing) await p.updateCall(run.runId, claim.epoch, pc.invocation.callId, { state: "waiting_approval", approvalId: approval.id });
      cp.pendingApprovals = [approval.id];
      await p.updateRun(run.runId, claim.epoch, { state: "waiting_approval", pending: { approvals: [approval.id], inputs: [] } });
      await this.emit(ctx, "approval_requested", { approvalId: approval.id, callIds: approval.callIds, expiresAt: approval.expiresAt, views: approval.view as unknown as JsonValue });
      cp.continuation = { reason: "approval", since: nowIso() };
      await this.checkpoint(ctx);
      // Notify after the suspension is durable; an interactive transport may decide before returning.
      try {
        await this.deps.approvals.notify(approval);
      } catch (e) {
        await this.audit(ctx, "approval_notify_failed", { approvalId: approval.id, error: sanitizeMessage((e as Error).message) });
      }
      approval = (await p.getApproval(approval.id)) ?? approval;
    }
    if (approval.status === "pending") {
      if (approval.expiresAt <= nowIso()) {
        await this.finish(ctx, "expired", undefined, new SFieldError("APPROVAL_EXPIRED", `approval ${approval.id} expired`));
        return "finished";
      }
      await this.park(ctx, "waiting_approval", { reason: "approval", note: approval.id }, { approvals: [approval.id], inputs: [] });
      return "parked";
    }
    await this.emit(ctx, "approval_resolved", { approvalId: approval.id, decision: approval.decision?.decision ?? approval.status, actor: approval.decision?.actor.subjectId ?? null });
    cp.pendingApprovals = [];
    delete cp.continuation;
    await p.updateRun(run.runId, claim.epoch, { state: "running", pending: { approvals: [], inputs: [] } });
    if (approval.status === "denied") {
      // A human-denied mutation ends the run as denied by default (§14.2).
      for (const pc of needing) await p.updateCall(run.runId, claim.epoch, pc.invocation.callId, { state: "rejected" });
      await this.finish(ctx, "denied", undefined, new SFieldError("APPROVAL_DENIED", `approval ${approval.id} denied${approval.decision?.comment ? `: ${approval.decision.comment}` : ""}`));
      return "finished";
    }
    for (const pc of needing) approvalIds.set(pc.invocation.callId, approval.id);
    return "continue";
  }

  private async collectInputs(ctx: RunContext, needing: PreparedCall[]): Promise<StepOutcome> {
    const { cp, run, principal, claim } = ctx;
    const p = this.deps.persistence;
    for (const pc of needing) {
      const callId = pc.invocation.callId;
      const requirement = inputRequirement(pc.def, pc.normalizedInputs)!;
      let request = (await p.listInputRequests({ runId: run.runId })).find((r) => r.callId === callId) ?? null;
      if (!request) {
        if (!this.deps.hasInputTransport) continue; // the executor reports the missing confirmation
        request = await this.deps.approvals.createInput({ runId: run.runId, tenantId: principal.tenantId, subjectId: principal.subjectId, callId, question: requirement.question, responseSchema: requirement.schema });
        cp.pendingInputs = [request.requestId];
        await p.updateRun(run.runId, claim.epoch, { state: "waiting_input", pending: { approvals: [], inputs: [request.requestId] } });
        await this.emit(ctx, "input_requested", { requestId: request.requestId, callId, question: request.question, expiresAt: request.expiresAt });
        cp.continuation = { reason: "input", since: nowIso() };
        await this.checkpoint(ctx);
        try {
          await this.deps.approvals.notifyInput(request);
        } catch (e) {
          await this.audit(ctx, "input_notify_failed", { requestId: request.requestId, error: sanitizeMessage((e as Error).message) });
        }
        request = (await p.getInputRequest(request.requestId)) ?? request;
      }
      if (request.status === "pending") {
        if (request.expiresAt <= nowIso()) continue; // executor reports expired
        await this.park(ctx, "waiting_input", { reason: "input", note: request.requestId }, { approvals: [], inputs: [request.requestId] });
        return "parked";
      }
      await this.emit(ctx, "input_resolved", { requestId: request.requestId, callId, status: request.status });
      cp.pendingInputs = [];
      delete cp.continuation;
      await p.updateRun(run.runId, claim.epoch, { state: "running", pending: { approvals: [], inputs: [] } });
    }
    return "continue";
  }

  /** Executes built-in interaction tools inside the pipeline's dispatch step (§8.4). */
  readonly builtinExecutor = async (def: ToolDefinition, inputs: JsonObject, ctx: { principal: Principal; runId: string; callId: string; signal: AbortSignal }): Promise<AdapterResult> => {
    const p = this.deps.persistence;
    const started = Date.now();
    const ok = (payload: JsonValue, effect: AdapterResult["effect"]): AdapterResult => ({ payload, payloadValid: true, effect, transport: { durationMs: Date.now() - started, bytes: Buffer.byteLength(JSON.stringify(payload)) } });
    const request = (await p.listInputRequests({ runId: ctx.runId })).find((r) => r.callId === ctx.callId);
    if (def.id === ASK_USER.id) {
      if (!request) return ok({ status: "pending", value: null }, "none");
      if (request.status !== "answered") return ok({ status: request.status === "expired" ? "expired" : "pending", value: null }, "none");
      const v = request.answer!.value;
      return ok({ status: "answered", value: typeof v === "string" ? v : JSON.stringify(v) }, "none");
    }
    if (def.id === MEMORY_REMEMBER.id) {
      if (!request || request.status !== "answered") {
        return ok({ status: request?.status === "expired" ? "rejected" : "confirmation_pending", memory_id: null, reason: request ? `confirmation ${request.status}` : "user confirmation is required and no input transport is configured" }, "none");
      }
      if (request.answer!.value !== true) return ok({ status: "rejected", memory_id: null, reason: "user declined" }, "none");
      const run = await p.getRun(ctx.runId);
      const sourceIds = run?.conversationId ? (await p.listMessages(run.conversationId, { limit: 1 })).map((m) => m.id) : [];
      try {
        const item = await this.deps.memory.put(ctx.principal, {
          scope: { kind: "subject", tenantId: ctx.principal.tenantId, subjectId: ctx.principal.subjectId },
          kind: "preference",
          content: String(inputs["content"]),
          structured: typeof inputs["key"] === "string" ? { key: inputs["key"], value: String(inputs["content"]) } : undefined,
          origin: "user_confirmed",
          provenance: [
            ...sourceIds.map((id) => ({ sourceType: "message" as const, sourceId: id, observedAt: nowIso() })),
            { sourceType: "host" as const, sourceId: `input:${request.requestId}`, observedAt: request.answer!.answeredAt },
          ],
        }, { idempotencyKey: ctx.callId });
        return ok({ status: "saved", memory_id: item.id, reason: null }, "confirmed");
      } catch (e) {
        const err = SFieldError.from(e);
        return ok({ status: "rejected", memory_id: null, reason: sanitizeMessage(err.message) }, "none");
      }
    }
    if (def.id === MEMORY_FORGET.id) {
      const receipt = await this.deps.memory.forget(ctx.principal, { id: String(inputs["memory_id"]) }, { idempotencyKey: ctx.callId });
      return ok({ status: receipt.count > 0 ? "forgotten" : "not_found" }, receipt.count > 0 ? "confirmed" : "none");
    }
    return { payloadValid: false, effect: "not_started", transport: { durationMs: 0, bytes: 0 }, error: { code: "UNKNOWN_TOOL", category: "configuration", message: `no executor for ${def.ref}`, retryable: false } };
  };

  // ---------------------------------------------------------------- completion and verification

  private async complete(ctx: RunContext, _message: Extract<NeutralMessage, { role: "assistant" }>): Promise<StepOutcome> {
    const { agent, cp } = ctx;
    const text = finalText(cp.runMessages);
    let output: JsonValue = text;
    const problems: string[] = [];
    if (agent.output.schema) {
      try {
        const parsed = JSON.parse(extractJson(text)) as JsonValue;
        const v = sharedValidator().validate(agent.output.schema, parsed);
        if (v.ok) output = parsed;
        else problems.push(`output does not match the required schema: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
      } catch {
        problems.push("output is not valid JSON for the required schema");
      }
    }
    if (problems.length === 0 && agent.output.verifier) {
      const verdict = await this.verify(ctx, agent.output.verifier, output);
      if (!verdict.ok) problems.push(verdict.reason ?? "verifier rejected the output");
    }
    if (problems.length === 0) {
      // Citations must resolve (§11.3).
      const unresolved = [...text.matchAll(/\[(source_\d+)\]/g)].map((m) => m[1]!).filter((id) => !ctx.run.citations?.[id]);
      if (unresolved.length) problems.push(`unresolvable citations: ${[...new Set(unresolved)].join(", ")}`);
    }
    if (problems.length === 0) {
      await this.finish(ctx, "completed", output);
      return "finished";
    }
    if (cp.counters.repairs < agent.output.max_repairs) {
      cp.counters.repairs++;
      await this.emit(ctx, "output_repair", { attempt: cp.counters.repairs, problems });
      cp.runMessages.push({ role: "user", parts: [{ type: "text", text: `Your previous answer was rejected by output verification: ${problems.join("; ")}. Produce a corrected final answer${agent.output.schema ? " as JSON matching the required schema, with no surrounding text" : ""}.` }] });
      return "continue";
    }
    await this.finish(ctx, "verification_failed", output, new SFieldError("INVALID_OUTPUT", problems.join("; ")));
    return "finished";
  }

  private async verify(ctx: RunContext, name: string, output: JsonValue): Promise<{ ok: boolean; reason?: string }> {
    const verifier = this.deps.verifiers[name];
    if (!verifier) return { ok: false, reason: `verifier ${name} is not registered` };
    await this.audit(ctx, "verification", { verifier: name, kind: verifier.kind });
    if (verifier.kind === "validator" && verifier.validate) return verifier.validate(output, { runId: ctx.run.runId, principal: ctx.principal });
    if (verifier.kind === "registry_tool" && verifier.toolRef) {
      const def = this.deps.registry.get(verifier.toolRef);
      if (!def || def.policy.effect !== "read") return { ok: false, reason: "verifier tool must be a registered read tool" };
      const callId = newId("call");
      await this.deps.persistence.prepareBatch(ctx.run.runId, ctx.claim.epoch, [{ callId, runId: ctx.run.runId, batchId: newId("batch"), turn: ctx.cp.counters.turns, order: 0, toolRef: def.ref, state: "proposed", proposedArguments: { output }, attempts: [], createdAt: nowIso(), updatedAt: nowIso() }]);
      try {
        const pc = await this.deps.pipeline.prepare({ def, inputs: { output }, principal: ctx.principal, runId: ctx.run.runId, callId, agentId: ctx.agent.id, preset: ctx.agent.policy.preset, configDigest: ctx.run.configDigest, connections: ctx.version.connections });
        const out = await this.deps.pipeline.dispatch({ prepared: pc, principal: ctx.principal, runId: ctx.run.runId, epoch: ctx.claim.epoch, agentId: ctx.agent.id, conversationId: ctx.run.conversationId, signal: ctx.controller.signal, budgetScopes: this.budgetScopes(ctx), connections: ctx.version.connections, onEvents: (evs) => this.deps.bus.publish(evs) });
        ctx.cp.counters.toolCalls++;
        const o = out.result.output as JsonObject | undefined;
        if (out.result.status !== "succeeded" || !o) return { ok: false, reason: out.result.error?.message ?? "verifier tool failed" };
        return { ok: o["ok"] === true, reason: typeof o["reason"] === "string" ? o["reason"] : undefined };
      } catch (e) {
        return { ok: false, reason: sanitizeMessage((e as Error).message) };
      }
    }
    if (verifier.kind === "model_grader" && verifier.graderModel) {
      const binding = ctx.version.modelBindings[verifier.graderModel];
      if (!binding) return { ok: false, reason: `grader model ${verifier.graderModel} is not bound` };
      ctx.cp.counters.modelCalls++;
      const request: NeutralModelRequest = {
        binding,
        instructions: [verifier.graderInstructions ?? "You grade an assistant answer. Reply with JSON only: {\"pass\": true|false, \"reason\": string}."],
        messages: [{ role: "user", parts: [{ type: "text", text: `Answer to grade:\n${typeof output === "string" ? output : JSON.stringify(output)}` }] }],
        tools: [],
        params: { maxOutputTokens: 300 },
        toolChoice: "none",
        outputSchema: { type: "object", additionalProperties: false, required: ["pass", "reason"], properties: { pass: { type: "boolean" }, reason: { type: "string" } } },
      };
      try {
        const res = await this.deps.gateway.dispatch(request, { runId: ctx.run.runId, signal: ctx.controller.signal, beginAttempt: async () => (ctx.cp.counters.providerAttempts++ < ctx.agent.budget.max_provider_attempts ? { attemptId: newId("att") } : null), onAttempt: async (rec) => { await this.deps.persistence.recordModelAttempt(ctx.run.runId, rec); if (rec.usage) { ctx.cp.counters.inputTokens += rec.usage.inputTokens; ctx.cp.counters.outputTokens += rec.usage.outputTokens; ctx.cp.counters.costMicroUsd += rec.costMicroUsd ?? 0; } } });
        const parsed = JSON.parse(extractJson(textOf(res.message))) as JsonObject;
        // A model score is advisory unless the host selected this standard (§14.5); the host did by configuring it.
        return { ok: parsed["pass"] === true, reason: typeof parsed["reason"] === "string" ? parsed["reason"] : undefined };
      } catch (e) {
        return { ok: false, reason: `grader failed: ${sanitizeMessage((e as Error).message)}` };
      }
    }
    return { ok: false, reason: `verifier ${name} is misconfigured` };
  }

  // ---------------------------------------------------------------- state transitions

  private async persistMessage(ctx: RunContext, role: MessageRecord["role"], content: JsonValue): Promise<void> {
    const { run, agent } = ctx;
    if (!run.conversationId || !agent.memory.conversation) return;
    const retentionMs = agent.memory.retention_days.conversation * 86400000;
    await this.deps.persistence.appendMessage({ conversationId: run.conversationId, tenantId: run.tenantId, runId: run.runId, role, content, createdAt: nowIso(), expiresAt: new Date(Date.now() + retentionMs).toISOString() });
  }

  private async checkpoint(ctx: RunContext): Promise<void> {
    ctx.cp.updatedAt = nowIso();
    await this.deps.persistence.saveCheckpoint(ctx.run.runId, ctx.claim.epoch, ctx.cp);
  }

  private async park(ctx: RunContext, state: RunState, continuation: Omit<NonNullable<Checkpoint["continuation"]>, "since"> & { since?: string }, pending: { approvals: string[]; inputs: string[] } = { approvals: [], inputs: [] }): Promise<void> {
    ctx.cp.continuation = { ...continuation, since: continuation.since ?? nowIso() };
    ctx.cp.suspendedAt = nowIso();
    await this.checkpoint(ctx);
    const usage = this.usage(ctx);
    const effects = await this.effects(ctx.run.runId);
    await this.deps.persistence.updateRun(ctx.run.runId, ctx.claim.epoch, { state, pending, usage, effects, citations: ctx.run.citations });
    await this.emit(ctx, state === "reconciliation_required" ? "reconciliation_required" : "run_suspended", { state, reason: continuation.reason, note: continuation.note ?? null, pending: pending as unknown as JsonValue });
    this.deps.telemetry?.event?.("sfield.run.suspended", { state, agent: ctx.agent.id });
  }

  private async finish(ctx: RunContext, state: RunState, output?: JsonValue, error?: SFieldError): Promise<void> {
    const p = this.deps.persistence;
    const usage = ctx.cp ? this.usage(ctx) : ctx.run.usage;
    const effects = await this.effects(ctx.run.runId);
    const patch: Partial<RunRecord> = { state, usage, effects, pending: { approvals: [], inputs: [] }, citations: ctx.run.citations };
    if (output !== undefined) patch.output = output;
    if (error) patch.error = error.toPublic();
    await p.updateRun(ctx.run.runId, ctx.claim.epoch, patch);
    if (ctx.cp) {
      delete ctx.cp.continuation;
      await this.checkpoint(ctx);
    }
    if (ctx.run.conversationId) await p.setActiveRun(ctx.run.conversationId, null, ctx.run.runId);
    await this.emit(ctx, "run_finished", { state, error: error ? { code: error.code, message: this.deps.scrubber.scrubText(error.message) } : null, usage: usage as unknown as JsonValue, effects: effects as unknown as JsonValue });
    this.deps.telemetry?.event?.("sfield.run.finished", { state, agent: ctx.agent?.id ?? ctx.run.agentId });
  }

  private async finishWithoutOwnership(run: RunRecord, state: RunState, error: { code: string; message: string }): Promise<void> {
    const claim = await this.deps.persistence.claim(run.scopeId, this.deps.ownerId, this.deps.leaseMs);
    if (!claim) return;
    try {
      await this.deps.persistence.updateRun(run.runId, claim.epoch, { state, error: { code: error.code, category: "configuration", message: error.message, retryable: false } });
      if (run.conversationId) await this.deps.persistence.setActiveRun(run.conversationId, null, run.runId);
      const events = await this.deps.persistence.appendEvents(run.runId, claim.epoch, [{ v: 1, id: newId("evt"), runId: run.runId, conversationId: run.conversationId, timestamp: nowIso(), type: "run_finished", payload: { state, error } }]);
      this.deps.bus.publish(events);
    } finally {
      await this.deps.persistence.release(claim);
      this.deps.bus.end(run.runId);
    }
  }

  private usage(ctx: RunContext): UsageSummary {
    const c: RunCounters = ctx.cp.counters;
    return { turns: c.turns, modelCalls: c.modelCalls, providerAttempts: c.providerAttempts, toolCalls: c.toolCalls, toolAttempts: c.toolAttempts, inputTokens: c.inputTokens, outputTokens: c.outputTokens, totalTokens: c.inputTokens + c.outputTokens, tokensReported: c.tokensReported, costMicroUsd: c.costMicroUsd, costLabel: c.costLabel, activeMs: c.activeMs, elapsedMs: Date.now() - Date.parse(ctx.cp.startedAt) };
  }

  private async effects(runId: string): Promise<EffectSummary[]> {
    const calls = await this.deps.persistence.listCalls(runId);
    const out: EffectSummary[] = [];
    for (const c of calls) {
      if (!c.invocation) continue;
      const def = this.deps.registry.get(c.toolRef);
      if (!def || def.policy.effect === "read") continue;
      const outcome: EffectSummary["outcome"] = c.result ? c.result.effect : c.state === "intent_committed" || c.state === "dispatched" ? "unknown" : "not_started";
      const e: EffectSummary = { callId: c.callId, toolRef: c.toolRef, effect: def.policy.effect, outcome, resource: c.invocation.resource };
      if (c.result?.outputRef) e.outputRef = c.result.outputRef.id;
      out.push(e);
    }
    return out;
  }

  private async emit(ctx: RunContext, type: string, payload: JsonObject): Promise<void> {
    const ev: RunEvent = { v: 1, id: newId("evt"), runId: ctx.run.runId, timestamp: nowIso(), type, payload };
    if (ctx.run.conversationId) ev.conversationId = ctx.run.conversationId;
    const stored = await this.deps.persistence.appendEvents(ctx.run.runId, ctx.claim.epoch, [ev]);
    this.deps.bus.publish(stored);
    for (const hook of this.deps.hooks) if (hook.point === "onEvent" && hook.onEvent) void Promise.resolve(hook.onEvent(stored[0]!)).catch(() => undefined);
  }

  private async audit(ctx: RunContext, type: string, data: JsonObject): Promise<void> {
    await this.deps.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: ctx.principal.tenantId, runId: ctx.run.runId, type, principal: { tenantId: ctx.principal.tenantId, subjectId: ctx.principal.subjectId }, configDigest: ctx.run.configDigest, data, preset: this.deps.preset }]);
  }

  private errorResult(callId: string, toolRef: string, code: string, message: string): { result: ToolResult; view: ToolResultView } {
    const result: ToolResult = { callId, toolRef, status: "failed", effect: "not_started", error: { code, category: code === "INVALID_INPUT" || code === "REPEATED_CALL" ? "validation" : code === "UNKNOWN_TOOL" ? "configuration" : "authorization", message: this.deps.scrubber.scrubText(message) }, meta: { attempts: 0, durationMs: 0, bytes: 0 } };
    return { result, view: this.deps.pipeline.modelView(result) };
  }
}

/** Built-ins that need an authenticated answer before they can execute (§14.4, §10.3). */
export function inputRequirement(def: ToolDefinition, inputs: JsonObject): { question: string; schema: JsonObject } | null {
  if (def.id === ASK_USER.id) {
    const type = typeof inputs["response_type"] === "string" ? inputs["response_type"] : "string";
    const schema: JsonObject = type === "boolean" ? { type: "boolean" } : type === "number" ? { type: "number" } : { type: "string", minLength: 1, maxLength: 4000 };
    if (Array.isArray(inputs["choices"]) && (inputs["choices"] as JsonValue[]).length) schema["enum"] = inputs["choices"];
    return { question: String(inputs["question"]), schema };
  }
  if (def.id === MEMORY_REMEMBER.id) {
    return { question: `Save this preference for future conversations? "${String(inputs["content"])}"`, schema: { type: "boolean" } };
  }
  return null;
}

export function textOf(message: Extract<NeutralMessage, { role: "assistant" }>): string {
  return message.parts.filter((pt): pt is Extract<NeutralPart, { type: "text" }> => pt.type === "text").map((pt) => pt.text).join("");
}

/** The candidate answer: text of the trailing consecutive assistant messages (continuations join). */
export function finalText(messages: NeutralMessage[]): string {
  const tail: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") break;
    tail.unshift(textOf(m));
  }
  return tail.join("");
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  if (fence) return fence[1]!;
  const start = trimmed.search(/[{[]/);
  if (start > 0) return trimmed.slice(start);
  return trimmed;
}

export function messageToNeutral(m: MessageRecord): NeutralMessage | null {
  if (m.role === "user") {
    const c = m.content as JsonObject;
    return { role: "user", parts: [{ type: "text", text: String(c["text"] ?? "") }] };
  }
  if (m.role === "assistant") return { role: "assistant", parts: (m.content as unknown as NeutralPart[]) ?? [] };
  if (m.role === "tool_results") return { role: "tool_results", results: (m.content as unknown as NeutralToolResult[]) ?? [] };
  return null;
}

export function historyTokens(transcript: NeutralMessage[]): number {
  return transcript.reduce((n, m) => n + estimateTokens(m.role === "tool_results" ? JSON.stringify(m.results) : m.parts.map((pt) => (pt.type === "text" ? pt.text : JSON.stringify(pt))).join("")), 0);
}
