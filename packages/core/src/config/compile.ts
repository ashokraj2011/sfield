/** Configuration compilation (§5.4): parse → checks → validation → includes → defaults → lookups → binding checks → hashing. */
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import type { Ajv2020 as Ajv2020Class, ErrorObject } from "ajv/dist/2020.js";
import type { BindingIdentity, JsonObject, JsonValue, SecretRef, ValueBinding } from "../types/common.js";
import type { PluginManifest } from "../types/options.js";
import type { HostLimits } from "../types/options.js";
import type { RetrievalTypeFactory } from "../types/retrieval.js";
import type { ToolAdapter, ToolDefinition } from "../types/tool.js";
import { ConfigError, ConfigErrors, SFieldError } from "../errors.js";
import { digestJson } from "../util/digest.js";
import { checkBinding } from "../util/refs.js";
import { deepFreeze } from "../util/freeze.js";
import { FORMATS_VERSION } from "../schema/formats.js";
import { sharedValidator } from "../schema/validator.js";
import { normalizeTool, BUILTIN_TOOL_IDS, type ToolSpec } from "../registry/define-tool.js";
import { AGENT_DEFAULTS, CONNECTION_DEFAULTS, CONTEXT_SOURCE_DEFAULTS, HOST_DEFAULTS, fillDefaults } from "./defaults.js";
import { substituteEnv, type LoadedDocument } from "./load.js";
import { applyOverrides } from "./overrides.js";
import { ROOT_CONFIG_SCHEMA } from "./root-schema.js";
import {
  COMPILER_VERSION,
  type ConfigNote,
  type EffectiveAgentConfig,
  type EffectiveConfig,
  type EffectiveConnectionConfig,
  type EffectiveModelConfig,
  type EffectiveSourceConfig,
  type EffectiveToolConfig,
  type LockManifest,
} from "./types.js";

const Ajv2020 = (((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown) as typeof Ajv2020Class;

export const GENERIC_PARAMS: readonly string[] = Object.freeze(["max_output_tokens", "temperature", "top_p", "stop_sequences"]);

export const PROVIDER_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ["max_output_tokens", "temperature", "top_p", "top_k", "stop_sequences"],
  openai_compatible: ["max_output_tokens", "temperature", "top_p", "stop_sequences", "seed", "presence_penalty", "frequency_penalty"],
});

export interface CompileRegistrations {
  codeTools: ToolDefinition[];
  adapters: Map<string, ToolAdapter>;
  providers: Set<string>;
  retrievalTypes: Map<string, RetrievalTypeFactory>;
  verifiers: Set<string>;
  prerequisites: Set<string>;
  contextTransforms: Set<string>;
  plugins: PluginManifest[];
  reconciliation: Set<string>;
}

export interface CompileContext {
  registrations: CompileRegistrations;
  bindings: { models: Record<string, BindingIdentity>; connections: Record<string, BindingIdentity>; retrieval: Record<string, BindingIdentity> };
  limits: HostLimits;
  env: Record<string, string | undefined>;
  overrides?: JsonObject[];
  /** When false, env credential presence is not checked (validation without an environment). */
  checkCredentials?: boolean;
  /** Secret names the host resolver can inspect (for {name} references). */
  knownSecretNames?: (name: string) => boolean;
}

let rootAjv: Ajv2020Class | undefined;
function rootValidator(): Ajv2020Class {
  if (!rootAjv) rootAjv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  return rootAjv;
}

function schemaErrorToConfigError(e: ErrorObject): ConfigError {
  const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "config";
  if (e.keyword === "additionalProperties") {
    const key = String((e.params as Record<string, unknown>)["additionalProperty"]);
    return new ConfigError("UNKNOWN_KEY", `${path}: unknown key ${JSON.stringify(key)}`, `${path}.${key}`, "Plugin-specific fields belong under extensions; check spelling against the field reference (§22)");
  }
  if (e.keyword === "required") {
    const key = String((e.params as Record<string, unknown>)["missingProperty"]);
    return new ConfigError("INVALID_CONFIG", `${path}: missing required field ${JSON.stringify(key)}`, `${path}.${key}`);
  }
  if (e.keyword === "propertyNames") {
    const key = String((e.params as Record<string, unknown>)["propertyName"]);
    return new ConfigError("INVALID_CONFIG", `${path}: invalid name ${JSON.stringify(key)}`, `${path}.${key}`, "Names use letters, digits, underscores, and hyphens; tool ids use lowercase dot-separated segments");
  }
  if (e.keyword === "oneOf") return new ConfigError("INVALID_CONFIG", `${path}: does not match exactly one permitted form`, path);
  return new ConfigError("INVALID_CONFIG", `${path}: ${e.message ?? e.keyword}`, path);
}

class Collector {
  errors: ConfigError[] = [];
  notes: ConfigNote[] = [];
  add(code: string, message: string, path: string, suggestion?: string): void {
    this.errors.push(new ConfigError(code, message, path, suggestion));
  }
  note(path: string, code: string, message: string): void {
    this.notes.push({ path, code, message });
  }
  capture(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (e instanceof ConfigError) this.errors.push(e);
      else if (e instanceof SFieldError) this.errors.push(new ConfigError(e.code, e.message, e.path ?? "config", e.suggestion));
      else throw e;
    }
  }
  throwIfAny(): void {
    if (this.errors.length > 0) throw new ConfigErrors(this.errors);
  }
}

function obj(v: JsonValue | undefined): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

export function compileConfig(loaded: LoadedDocument, ctx: CompileContext): EffectiveConfig {
  const provenance: Record<string, string> = { ...loaded.provenance };
  const c = new Collector();
  const validator = sharedValidator();

  // Overrides, then env substitution in declared fields only.
  let doc = applyOverrides(loaded.document, ctx.overrides ?? [], provenance);
  const extraEnvPatterns: string[] = [];
  for (const m of ctx.registrations.plugins) for (const f of m.substitutableFields ?? []) extraEnvPatterns.push(`extensions.${m.id}.${f}`);
  doc = substituteEnv(doc, ctx.env, provenance, extraEnvPatterns);

  // Root schema.
  const validate = rootValidator().compile(ROOT_CONFIG_SCHEMA);
  if (!validate(doc)) {
    for (const e of validate.errors ?? []) c.errors.push(schemaErrorToConfigError(e));
    c.throwIfAny();
  }

  const modelsIn = obj(doc["models"]);
  const connectionsIn = obj(doc["connections"]);
  const sourcesIn = obj(doc["sources"]);
  const toolsIn = obj(doc["tools"]);
  const agentsIn = obj(doc["agents"]);
  const extensionsIn = obj(doc["extensions"]);

  // ---- models
  const models: Record<string, EffectiveModelConfig> = {};
  for (const [id, raw] of Object.entries(modelsIn)) {
    const m = obj(raw);
    const path = `models.${id}`;
    const hasBinding = m["binding"] !== undefined;
    const shorthandKeys = ["provider", "model", "credential", "base_url", "params", "quirks", "limits", "classification", "prices", "api_version"].filter((k) => m[k] !== undefined);
    if (hasBinding && shorthandKeys.length > 0) {
      c.add("INVALID_CONFIG", `${path}: binding and provider shorthand cannot be mixed (found ${shorthandKeys.join(", ")})`, path, "Use either binding: <name> or provider/model/credential");
      continue;
    }
    if (!hasBinding && m["provider"] === undefined) {
      c.add("INVALID_CONFIG", `${path}: declare binding or provider`, path, "Example: provider: anthropic, model: ..., credential: {env: ANTHROPIC_API_KEY}");
      continue;
    }
    const entry: EffectiveModelConfig = { id, form: hasBinding ? "binding" : "shorthand", params: obj(m["params"]) };
    if (hasBinding) {
      const b = String(m["binding"]);
      if (!ctx.bindings.models[b]) c.add("UNKNOWN_BINDING", `${path}.binding: host model binding ${JSON.stringify(b)} is not registered`, `${path}.binding`, `Pass bindings.models.${b} to SField.create or use provider shorthand`);
      entry.binding = b;
    } else {
      const provider = String(m["provider"]);
      if (!ctx.registrations.providers.has(provider)) c.add("UNKNOWN_BINDING", `${path}.provider: provider ${JSON.stringify(provider)} is not registered`, `${path}.provider`);
      if (typeof m["model"] !== "string" || m["model"].length === 0) c.add("INVALID_CONFIG", `${path}.model: required`, `${path}.model`);
      if (m["credential"] === undefined) c.add("INVALID_CONFIG", `${path}.credential: required`, `${path}.credential`, "Example: credential: {env: ANTHROPIC_API_KEY}");
      else checkSecretPresence(m["credential"] as unknown as SecretRef, `${path}.credential`, ctx, c);
      if (provider === "openai_compatible" && typeof m["base_url"] !== "string") c.add("INVALID_CONFIG", `${path}.base_url: required for openai_compatible`, `${path}.base_url`, "Example: base_url: http://localhost:11434/v1");
      if (typeof m["base_url"] === "string") {
        try {
          const u = new URL(m["base_url"]);
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
        } catch {
          c.add("INVALID_CONFIG", `${path}.base_url: must be an http(s) URL`, `${path}.base_url`);
        }
      }
      const supported = PROVIDER_PARAMS[provider] ?? GENERIC_PARAMS;
      for (const k of Object.keys(entry.params)) {
        if (!supported.includes(k)) c.add("INVALID_CONFIG", `${path}.params.${k}: not a declared supported parameter for ${provider}`, `${path}.params.${k}`, `Supported: ${supported.join(", ")}`);
      }
      entry.provider = provider;
      entry.model = m["model"] as string;
      entry.credential = m["credential"] as unknown as SecretRef;
      if (typeof m["base_url"] === "string") entry.base_url = m["base_url"];
      if (Array.isArray(m["quirks"])) entry.quirks = m["quirks"] as string[];
      if (m["limits"]) entry.limits = obj(m["limits"]) as EffectiveModelConfig["limits"];
      if (typeof m["classification"] === "string") entry.classification = m["classification"] as EffectiveModelConfig["classification"];
      if (m["prices"]) entry.prices = obj(m["prices"]) as unknown as EffectiveModelConfig["prices"];
      if (typeof m["api_version"] === "string") entry.api_version = m["api_version"];
    }
    if (typeof m["fallback"] === "string") entry.fallback = m["fallback"];
    models[id] = entry;
  }
  for (const [id, m] of Object.entries(models)) {
    if (m.fallback !== undefined) {
      if (m.fallback === id) c.add("INVALID_REFERENCE", `models.${id}.fallback: cannot reference itself`, `models.${id}.fallback`);
      else if (!models[m.fallback]) c.add("UNKNOWN_MODEL", `models.${id}.fallback: unknown model ${JSON.stringify(m.fallback)}`, `models.${id}.fallback`);
    }
  }

  // ---- connections
  const connections: Record<string, EffectiveConnectionConfig> = {};
  for (const [id, raw] of Object.entries(connectionsIn)) {
    const path = `connections.${id}`;
    const cn = fillDefaults(obj(raw), CONNECTION_DEFAULTS, path, provenance);
    let host = "";
    try {
      const u = new URL(String(cn["base_url"]));
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      host = u.hostname;
    } catch {
      c.add("INVALID_CONFIG", `${path}.base_url: must be an http(s) URL`, `${path}.base_url`);
    }
    const allowed = Array.isArray(cn["allowed_hosts"]) ? (cn["allowed_hosts"] as string[]) : host ? [host] : [];
    if (!Array.isArray(cn["allowed_hosts"])) provenance[`${path}.allowed_hosts`] = "default";
    if (host && !allowed.includes(host)) c.add("INVALID_CONFIG", `${path}.allowed_hosts: must include the base URL host ${host}`, `${path}.allowed_hosts`);
    const entry: EffectiveConnectionConfig = {
      id,
      base_url: String(cn["base_url"]),
      allowed_hosts: allowed,
      classification: cn["classification"] as EffectiveConnectionConfig["classification"],
      timeout_ms: Number(cn["timeout_ms"]),
    };
    if (cn["auth"]) {
      const a = obj(cn["auth"]);
      const auth: NonNullable<EffectiveConnectionConfig["auth"]> = { type: a["type"] as "bearer" | "header" | "basic", credential: a["credential"] as unknown as SecretRef };
      if (auth.type === "header" && typeof a["name"] !== "string") c.add("INVALID_CONFIG", `${path}.auth.name: required for header auth`, `${path}.auth.name`);
      if (typeof a["name"] === "string") auth.name = a["name"];
      checkSecretPresence(auth.credential, `${path}.auth.credential`, ctx, c);
      entry.auth = auth;
    }
    if (cn["headers"]) {
      const h = obj(cn["headers"]) as Record<string, string>;
      for (const name of Object.keys(h)) {
        if (/^(authorization|cookie|proxy-authorization)$/i.test(name)) c.add("INVALID_CONFIG", `${path}.headers.${name}: credential headers come from auth, not static headers`, `${path}.headers.${name}`);
      }
      entry.headers = h;
    }
    connections[id] = entry;
  }

  // ---- sources
  const sources: Record<string, EffectiveSourceConfig> = {};
  for (const [id, raw] of Object.entries(sourcesIn)) {
    const s = obj(raw);
    const path = `sources.${id}`;
    if (s["binding"] !== undefined && s["type"] !== undefined) {
      c.add("INVALID_CONFIG", `${path}: binding and type cannot be mixed`, path);
      continue;
    }
    if (s["binding"] !== undefined) {
      const extra = Object.keys(s).filter((k) => k !== "binding");
      if (extra.length) c.add("INVALID_CONFIG", `${path}: binding form accepts no other keys (${extra.join(", ")})`, path);
      if (!ctx.bindings.retrieval[String(s["binding"])]) c.add("UNKNOWN_BINDING", `${path}.binding: host retrieval binding ${JSON.stringify(s["binding"])} is not registered`, `${path}.binding`, `Pass bindings.retrieval.${String(s["binding"])} to SField.create`);
      sources[id] = { id, form: "binding", binding: String(s["binding"]), config: {} };
      continue;
    }
    if (s["type"] === undefined) {
      c.add("INVALID_CONFIG", `${path}: declare binding or type`, path, "Example: type: local_files, path: ./knowledge");
      continue;
    }
    const type = String(s["type"]);
    const factory = ctx.registrations.retrievalTypes.get(type);
    if (!factory) {
      c.add("UNKNOWN_BINDING", `${path}.type: retrieval type ${JSON.stringify(type)} is not registered`, `${path}.type`, `Registered types: ${[...ctx.registrations.retrievalTypes.keys()].join(", ") || "none (the local preset provides local_files)"}`);
      continue;
    }
    const cfg: JsonObject = { ...s };
    delete cfg["type"];
    const v = rootValidator().compile(factory.configSchema);
    if (!v(cfg)) {
      for (const e of v.errors ?? []) {
        const ce = schemaErrorToConfigError(e);
        c.add(ce.code, `${path}.${ce.path === "config" ? "" : ce.path}`.replace(/\.$/, "") + `: ${ce.message.replace(/^config: /, "")}`, `${path}.${ce.path}`, ce.suggestion);
      }
    }
    sources[id] = { id, form: "type", type, config: cfg };
  }

  // ---- tools (configured)
  const tools: Record<string, EffectiveToolConfig> = {};
  const toolVersions = new Map<string, Array<{ ref: string; digest: string; source: ToolDefinition["source"] }>>();
  for (const [id, raw] of Object.entries(toolsIn)) {
    const t = obj(raw);
    const path = `tools.${id}`;
    c.capture(() => {
      const adapterId = typeof t["adapter"] === "string" ? t["adapter"] : undefined;
      if (!adapterId) throw new ConfigError("INVALID_CONFIG", `${path}.adapter: required for configured tools`, `${path}.adapter`, "Example: adapter: http");
      const adapter = ctx.registrations.adapters.get(adapterId);
      if (!adapter || adapterId === "function") throw new ConfigError("UNKNOWN_ADAPTER", `${path}.adapter: adapter ${JSON.stringify(adapterId)} is not registered`, `${path}.adapter`, `Registered adapters: ${[...ctx.registrations.adapters.keys()].filter((a) => a !== "function").join(", ") || "none"}`);
      const connectionId = typeof t["connection"] === "string" ? t["connection"] : undefined;
      if (connectionId && !connections[connectionId] && !ctx.bindings.connections[connectionId]) {
        throw new ConfigError("UNKNOWN_BINDING", `${path}.connection: connection ${JSON.stringify(connectionId)} is not configured or bound`, `${path}.connection`, `Add connections.${connectionId} or pass bindings.connections.${connectionId}`);
      }
      const operation = obj(t["operation"]);
      if (t["operation"] === undefined) throw new ConfigError("INVALID_CONFIG", `${path}.operation: required`, `${path}.operation`);
      const opValidate = rootValidator().compile(adapter.operationSchema);
      if (!opValidate(operation)) {
        const e = (opValidate.errors ?? [])[0]!;
        const ce = schemaErrorToConfigError(e);
        throw new ConfigError(ce.code, `${path}.operation${ce.path === "config" ? "" : "." + ce.path}: ${ce.message.replace(/^[^:]*: /, "")}`, `${path}.operation.${ce.path}`, ce.suggestion);
      }
      checkOperationBindings(operation, `${path}.operation`, c);
      const policyIn = obj(t["policy"]);
      const spec: ToolSpec = {
        id,
        version: String(t["version"]),
        description: String(t["description"]),
        inputs: obj(t["inputs"]),
        outputs: obj(t["outputs"]),
        adapter: adapterId,
        connection: connectionId,
        operation,
        resource: t["resource"] ? (obj(t["resource"]) as unknown as ToolSpec["resource"]) : undefined,
        authorization: t["authorization"] ? (obj(t["authorization"]) as unknown as ToolSpec["authorization"]) : undefined,
        deduplication: t["deduplication"] ? (snakeDedup(obj(t["deduplication"])) as unknown as ToolSpec["deduplication"]) : undefined,
        extensions: t["extensions"] ? obj(t["extensions"]) : undefined,
        policy: {
          effect: policyIn["effect"] as "read" | "write" | "destructive" | undefined,
          action: policyIn["action"] as string | undefined,
          classification: policyIn["classification"] as EffectiveToolConfig["policy"]["classification"] | undefined,
          timeoutMs: policyIn["timeout_ms"] as number | undefined,
          maxAttempts: policyIn["max_attempts"] as number | undefined,
          retrySafety: policyIn["retry_safety"] as "never" | "repeatable" | "deduplicated" | undefined,
          maxOutputBytes: policyIn["max_output_bytes"] as number | undefined,
          requiresApproval: policyIn["requires_approval"] as boolean | undefined,
          costMicroUsd: policyIn["cost_microusd"] as number | undefined,
          prerequisite: policyIn["prerequisite"] as string | undefined,
          pollable: policyIn["pollable"] ? { minIntervalMs: Number(obj(policyIn["pollable"])["min_interval_ms"]) } : undefined,
          conflictKey: policyIn["conflict_key"] as ValueBinding | undefined,
        },
      };
      stripUndefined(spec.policy as Record<string, unknown>);
      const def = normalizeTool(spec, { source: "config" });
      for (const n of def.notes) c.note(path, "DEFAULT_RESOURCE", n);
      if (def.policy.prerequisite && !ctx.registrations.prerequisites.has(def.policy.prerequisite)) {
        throw new ConfigError("UNKNOWN_BINDING", `${path}.policy.prerequisite: host prerequisite ${JSON.stringify(def.policy.prerequisite)} is not registered`, `${path}.policy.prerequisite`, "Pass prerequisites: { name: check } to SField.create");
      }
      if (def.deduplication?.reconcileBinding && !ctx.registrations.reconciliation.has(def.deduplication.reconcileBinding)) {
        throw new ConfigError("UNKNOWN_BINDING", `${path}.deduplication.reconcile_binding: ${JSON.stringify(def.deduplication.reconcileBinding)} is not registered`, `${path}.deduplication.reconcile_binding`, "Pass reconciliation: { name: fn } to SField.create");
      }
      if (def.policy.classification && connectionId && connections[connectionId] && classificationRank(connections[connectionId]!.classification) > classificationRank(def.policy.classification)) {
        c.note(`${path}.policy.classification`, "CLASSIFICATION_RAISED", `raised to ${connections[connectionId]!.classification} by connection ${connectionId}`);
      }
      const eff: EffectiveToolConfig = {
        id,
        version: def.version,
        ref: def.ref,
        description: def.description,
        adapter: adapterId,
        inputs: def.inputs,
        outputs: def.outputs,
        policy: {
          effect: def.policy.effect,
          action: def.policy.action,
          classification: def.policy.classification,
          timeout_ms: def.policy.timeoutMs,
          max_attempts: def.policy.maxAttempts,
          retry_safety: def.policy.retrySafety,
          max_output_bytes: def.policy.maxOutputBytes,
          requires_approval: def.policy.requiresApproval,
          cost_microusd: def.policy.costMicroUsd,
        },
        digest: def.digest,
      };
      if (connectionId) eff.connection = connectionId;
      eff.operation = operation;
      if (def.outputSelect) eff.select = def.outputSelect;
      if (def.resource) eff.resource = def.resource;
      if (def.policy.prerequisite) eff.policy.prerequisite = def.policy.prerequisite;
      if (def.policy.pollable) eff.policy.pollable = { min_interval_ms: def.policy.pollable.minIntervalMs };
      if (def.policy.conflictKey) eff.policy.conflict_key = def.policy.conflictKey;
      if (def.deduplication) eff.deduplication = def.deduplication;
      if (def.extensions) eff.extensions = def.extensions;
      tools[id] = eff;
      const list = toolVersions.get(id) ?? [];
      list.push({ ref: def.ref, digest: def.digest, source: "config" });
      toolVersions.set(id, list);
    });
  }
  for (const def of ctx.registrations.codeTools) {
    const list = toolVersions.get(def.id) ?? [];
    const clash = list.find((v) => v.ref === def.ref);
    if (clash) {
      if (clash.digest !== def.digest) c.add("DUPLICATE_TOOL", `tools.${def.id}: ${def.ref} is registered in code and configuration with different definitions`, `tools.${def.id}`, "Register one implementation per id@version");
      continue;
    }
    list.push({ ref: def.ref, digest: def.digest, source: def.source });
    toolVersions.set(def.id, list);
  }

  // ---- agents
  const agents: Record<string, EffectiveAgentConfig> = {};
  const hostToolGrants = ctx.limits.grants?.tools;
  const hostEffects = ctx.limits.grants?.effects;
  const ld = { ...HOST_DEFAULTS.loopDetection, ...(ctx.limits.loopDetection ?? {}) };
  const maxTools = ctx.limits.maxExposedTools;
  for (const [id, raw] of Object.entries(agentsIn)) {
    const path = `agents.${id}`;
    const a = fillDefaults(obj(raw), AGENT_DEFAULTS as unknown as Record<string, unknown>, path, provenance);
    c.capture(() => {
      // instructions
      let instructions: string | undefined = typeof a["instructions"] === "string" ? a["instructions"] : undefined;
      let instructionsSource: string | undefined;
      if (a["instructions_file"] !== undefined) {
        if (instructions !== undefined) throw new ConfigError("INVALID_CONFIG", `${path}: instructions and instructions_file are mutually exclusive`, `${path}.instructions_file`);
        const rel = String(a["instructions_file"]);
        if (isAbsolute(rel)) throw new ConfigError("INVALID_CONFIG", `${path}.instructions_file: must be relative to the configuration file`, `${path}.instructions_file`);
        const abs = resolve(loaded.configDir, rel);
        try {
          instructions = readFileSync(abs, "utf8");
        } catch (e) {
          throw new ConfigError("INVALID_CONFIG", `${path}.instructions_file: cannot read ${rel}: ${(e as Error).message}`, `${path}.instructions_file`, "Create the file or fix the path");
        }
        instructionsSource = relative(loaded.configDir, abs) || rel;
        provenance[`${path}.instructions`] = `file:${instructionsSource}`;
      }
      if (instructions === undefined || instructions.trim().length === 0) {
        throw new ConfigError("INVALID_CONFIG", `${path}.instructions: required (or instructions_file)`, `${path}.instructions`, "Add literal instructions or instructions_file: ./instructions.md");
      }
      if (instructions.includes("${env:")) throw new ConfigError("INVALID_CONFIG", `${path}.instructions: \${env:} is not permitted in instructions`, `${path}.instructions`);
      // model
      const modelId = String(a["model"]);
      if (!models[modelId]) {
        throw new ConfigError("UNKNOWN_MODEL", `${path}.model: model ${JSON.stringify(modelId)} is not defined`, `${path}.model`, modelId === "default" ? "Define models.default (provider shorthand or binding) or set agent.model" : `Define models.${modelId}`);
      }
      // tools
      const preset = String(obj(a["policy"])["preset"]) as EffectiveAgentConfig["policy"]["preset"];
      const pinned: string[] = [];
      for (const [i, refRaw] of ((a["tools"] as string[]) ?? []).entries()) {
        const tp = `${path}.tools[${i}]`;
        const ref = String(refRaw);
        const [tid, ver] = ref.split("@");
        if (!tid) throw new ConfigError("INVALID_REFERENCE", `${tp}: empty tool reference`, tp);
        if (BUILTIN_TOOL_IDS.includes(tid)) {
          throw new ConfigError("INVALID_CONFIG", `${tp}: ${tid} is a built-in interaction tool; enable it through memory/transport settings and host grants, not the tools list`, tp);
        }
        const versions = toolVersions.get(tid);
        if (!versions || versions.length === 0) throw new ConfigError("UNKNOWN_TOOL", `${tp}: tool ${JSON.stringify(tid)} is not registered`, tp, `Registered tools: ${[...toolVersions.keys()].sort().join(", ") || "none"}`);
        let chosen: { ref: string; digest: string };
        if (ver) {
          const exact = versions.find((v) => v.ref === `${tid}@${ver}`);
          if (!exact) throw new ConfigError("UNKNOWN_TOOL", `${tp}: version ${ver} of ${tid} is not registered`, tp, `Available: ${versions.map((v) => v.ref).join(", ")}`);
          chosen = exact;
        } else if (versions.length === 1) chosen = versions[0]!;
        else throw new ConfigError("AMBIGUOUS_TOOL_VERSION", `${tp}: ${tid} has ${versions.length} eligible versions; pin one`, tp, `Use one of: ${versions.map((v) => v.ref).join(", ")}`);
        if (pinned.includes(chosen.ref)) throw new ConfigError("INVALID_CONFIG", `${tp}: ${chosen.ref} listed twice`, tp);
        if (hostToolGrants && !hostToolGrants.includes(tid) && !hostToolGrants.includes(chosen.ref)) {
          throw new ConfigError("ACCESS_DENIED", `${tp}: ${chosen.ref} is outside the host tool grants`, tp, "Agents can only narrow host grants (§9.1)");
        }
        const effect = effectOf(chosen.ref, tools, ctx.registrations.codeTools);
        if (preset === "read_only" && effect !== "read") {
          throw new ConfigError("EFFECT_NOT_ALLOWED", `${tp}: ${chosen.ref} has effect ${effect}; preset read_only permits read tools only`, tp, "Use preset supervised, or remove the tool");
        }
        if (hostEffects && !hostEffects.includes(effect)) {
          throw new ConfigError("EFFECT_NOT_ALLOWED", `${tp}: ${chosen.ref} has effect ${effect}, not granted by the host`, tp);
        }
        pinned.push(chosen.ref);
      }
      // context
      const ctxIn = obj(a["context"]);
      const sourcesOut: EffectiveAgentConfig["context"]["sources"] = [];
      for (const [i, sRaw] of ((ctxIn["sources"] as JsonValue[]) ?? []).entries()) {
        const sp = `${path}.context.sources[${i}]`;
        const s = fillDefaults(obj(sRaw), CONTEXT_SOURCE_DEFAULTS, sp, provenance);
        const sid = String(s["source"]);
        if (!sources[sid]) throw new ConfigError("UNKNOWN_SOURCE", `${sp}.source: source ${JSON.stringify(sid)} is not defined`, `${sp}.source`, `Define sources.${sid}`);
        const err = checkBinding(s["query"], ["message", "run", "attributes"], `${sp}.query`);
        if (err) throw new ConfigError("INVALID_REFERENCE", err, `${sp}.query`, "Context queries may reference message.text, run.inputs.*, or attributes.*");
        const entry: EffectiveAgentConfig["context"]["sources"][number] = {
          source: sid,
          query: s["query"] as unknown as ValueBinding,
          max_items: Number(s["max_items"]),
          max_tokens: Number(s["max_tokens"]),
          required: Boolean(s["required"]),
          timeout_ms: Number(s["timeout_ms"]),
        };
        if (s["filters"]) entry.filters = obj(s["filters"]);
        if (s["max_age_seconds"] !== undefined) entry.max_age_seconds = Number(s["max_age_seconds"]);
        sourcesOut.push(entry);
      }
      const maxInput = Number(ctxIn["max_input_tokens"]);
      const outputReserve = Number(ctxIn["output_reserve_tokens"]);
      const agentMaxTools = Number(ctxIn["max_tools"]);
      if (maxTools !== undefined && agentMaxTools > maxTools) throw new ConfigError("INVALID_CONFIG", `${path}.context.max_tools: ${agentMaxTools} exceeds the host ceiling ${maxTools}`, `${path}.context.max_tools`);
      if (typeof ctxIn["summarizer"] === "string" && !models[ctxIn["summarizer"]] && !ctx.registrations.contextTransforms.has(ctxIn["summarizer"])) {
        throw new ConfigError("UNKNOWN_BINDING", `${path}.context.summarizer: ${JSON.stringify(ctxIn["summarizer"])} is neither a model nor a registered context transform`, `${path}.context.summarizer`);
      }
      // output
      const outIn = obj(a["output"]);
      if (outIn["schema"] !== undefined) {
        const issues = validator.check(outIn["schema"], { path: `${path}.output.schema`, requireClosedObjects: true });
        if (issues.length) throw new ConfigError(issues[0]!.code, issues[0]!.message, issues[0]!.path, issues[0]!.suggestion);
      }
      if (typeof outIn["verifier"] === "string" && !ctx.registrations.verifiers.has(outIn["verifier"])) {
        throw new ConfigError("UNKNOWN_BINDING", `${path}.output.verifier: verifier ${JSON.stringify(outIn["verifier"])} is not registered`, `${path}.output.verifier`, "Pass verifiers: { name: verifier } to SField.create");
      }
      // loop detection ceilings
      const rt = obj(a["runtime"]);
      const loop = obj(rt["loop_detection"]);
      const window = Number(loop["identical_call_window"]);
      if (window < ld.minWindow || window > ld.maxWindow) throw new ConfigError("INVALID_CONFIG", `${path}.runtime.loop_detection.identical_call_window: ${window} is outside the host ceiling [${ld.minWindow}, ${ld.maxWindow}]`, `${path}.runtime.loop_detection.identical_call_window`);
      if (loop["enabled"] === false && !ld.allowDisable) throw new ConfigError("INVALID_CONFIG", `${path}.runtime.loop_detection.enabled: the host does not allow disabling loop detection`, `${path}.runtime.loop_detection.enabled`);
      if (Number(loop["max_polls_per_run"]) > ld.maxPollsPerRun) throw new ConfigError("INVALID_CONFIG", `${path}.runtime.loop_detection.max_polls_per_run: exceeds the host ceiling ${ld.maxPollsPerRun}`, `${path}.runtime.loop_detection.max_polls_per_run`);
      if (loop["on_repeat"] === "warn") c.note(`${path}.runtime.loop_detection.on_repeat`, "MUTATION_REPEAT_ALWAYS_FAILS", "warn applies to read tools only; repeated write/destructive calls always fail (§14.7)");
      const mem = obj(a["memory"]);
      const budget = obj(a["budget"]);
      const agent: EffectiveAgentConfig = {
        id,
        model: modelId,
        instructions,
        tools: pinned,
        memory: {
          conversation: Boolean(mem["conversation"]),
          preferences: mem["preferences"] as "off" | "explicit",
          facts: mem["facts"] as "off" | "explicit",
          retention_days: obj(mem["retention_days"]) as unknown as EffectiveAgentConfig["memory"]["retention_days"],
        },
        context: {
          max_input_tokens: maxInput,
          output_reserve_tokens: outputReserve,
          max_tools: agentMaxTools,
          sources: sourcesOut,
          priority: (ctxIn["priority"] as EffectiveAgentConfig["context"]["priority"]) ?? [...AGENT_DEFAULTS.context.priority],
        },
        policy: { preset },
        budget: budget as unknown as EffectiveAgentConfig["budget"],
        output: { max_repairs: Number(outIn["max_repairs"]), stream: outIn["stream"] !== false },
        runtime: {
          loop_detection: {
            enabled: loop["enabled"] !== false,
            identical_call_window: window,
            on_first: loop["on_first"] as "warn" | "fail",
            on_repeat: loop["on_repeat"] as "fail" | "warn",
            max_polls_per_run: Number(loop["max_polls_per_run"]),
          },
        },
        extensions: obj(a["extensions"]),
      };
      if (instructionsSource) agent.instructions_source = instructionsSource;
      if (typeof ctxIn["summarizer"] === "string") agent.context.summarizer = ctxIn["summarizer"];
      if (outIn["schema"]) agent.output.schema = obj(outIn["schema"]);
      if (typeof outIn["verifier"] === "string") agent.output.verifier = outIn["verifier"];
      for (const k of Object.keys(agent.extensions)) {
        if (!ctx.registrations.plugins.some((p) => p.id === k)) throw new ConfigError("UNKNOWN_PLUGIN", `${path}.extensions.${k}: no installed plugin owns this key`, `${path}.extensions.${k}`, "Install the plugin and pass it in SField.create plugins");
      }
      agents[id] = agent;
    });
  }

  // ---- extensions
  for (const [k, v] of Object.entries(extensionsIn)) {
    const manifest = ctx.registrations.plugins.find((p) => p.id === k);
    if (!manifest) {
      c.add("UNKNOWN_PLUGIN", `extensions.${k}: no installed plugin owns this key`, `extensions.${k}`, "Install the plugin and pass it in SField.create plugins");
      continue;
    }
    if (manifest.configSchema) {
      const v2 = rootValidator().compile(manifest.configSchema);
      if (!v2(v)) for (const e of v2.errors ?? []) {
        const ce = schemaErrorToConfigError(e);
        c.add(ce.code, `extensions.${k}.${ce.path}: ${ce.message.replace(/^[^:]*: /, "")}`, `extensions.${k}.${ce.path}`, ce.suggestion);
      }
    }
  }

  c.throwIfAny();

  // ---- lock manifest and digest
  const lockTools: LockManifest["tools"] = {};
  for (const [, versions] of toolVersions) for (const v of versions) lockTools[v.ref] = { ref: v.ref, digest: v.digest, source: v.source };
  const lockPlugins: LockManifest["plugins"] = {};
  for (const p of ctx.registrations.plugins) lockPlugins[p.id] = { version: p.version, buildDigest: p.buildDigest };
  const lockBindings: LockManifest["bindings"] = {};
  for (const [id, m] of Object.entries(models)) {
    lockBindings[`model:${id}`] = { kind: "model", identity: m.form === "binding" ? ctx.bindings.models[m.binding!]! : shorthandIdentity("model", id, [m.provider!, m.model!, m.base_url ?? ""], m.classification ?? "restricted") };
  }
  for (const [id, cn] of Object.entries(connections)) {
    lockBindings[`connection:${id}`] = { kind: "connection", identity: shorthandIdentity("connection", id, [cn.base_url], cn.classification) };
  }
  for (const [id, b] of Object.entries(ctx.bindings.connections)) if (!lockBindings[`connection:${id}`]) lockBindings[`connection:${id}`] = { kind: "connection", identity: b };
  for (const [id, s] of Object.entries(sources)) {
    lockBindings[`retrieval:${id}`] = { kind: "retrieval", identity: s.form === "binding" ? ctx.bindings.retrieval[s.binding!]! : shorthandIdentity("retrieval", id, [s.type!, JSON.stringify(s.config)], "internal") };
  }
  const lock: LockManifest = {
    version: 1,
    configDigest: "",
    tools: sortRecord(lockTools),
    plugins: sortRecord(lockPlugins),
    bindings: sortRecord(lockBindings),
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    formats: FORMATS_VERSION,
  };
  const digestInput = {
    config: { version: 1, models: stripCredentials(models), connections: stripCredentials(connections), sources, tools, agents, extensions: extensionsIn },
    lock: { tools: lock.tools, plugins: lock.plugins, bindings: lock.bindings },
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    formats: FORMATS_VERSION,
  };
  const digest = digestJson(digestInput);
  lock.configDigest = digest;

  const effective: EffectiveConfig = {
    version: 1,
    models: sortRecord(models),
    connections: sortRecord(connections),
    sources: sortRecord(sources),
    tools: sortRecord(tools),
    agents: sortRecord(agents),
    extensions: extensionsIn,
    digest,
    lock,
    provenance,
    notes: c.notes,
    configDir: loaded.configDir,
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
  };
  return deepFreeze(effective);
}

function stripUndefined(o: Record<string, unknown>): void {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
}

function snakeDedup(d: JsonObject): JsonObject {
  const out: JsonObject = {
    keyLocation: d["key_location"] as JsonValue,
    scope: d["scope"] as JsonValue,
    retentionSeconds: d["retention_seconds"] as JsonValue,
    payloadMismatch: d["payload_mismatch"] as JsonValue,
  };
  if (d["reconcile_binding"] !== undefined) out["reconcileBinding"] = d["reconcile_binding"] as JsonValue;
  return out;
}

function checkSecretPresence(ref: SecretRef, path: string, ctx: CompileContext, c: Collector): void {
  if (ctx.checkCredentials === false) return;
  if ("env" in ref) {
    if (ctx.env[ref.env] === undefined || ctx.env[ref.env] === "") {
      c.add("MISSING_CREDENTIAL", `${path}: environment variable ${ref.env} is not set`, path, `Set ${ref.env} (see .env.example)`);
    }
  } else if (ctx.knownSecretNames && !ctx.knownSecretNames(ref.name)) {
    c.add("MISSING_CREDENTIAL", `${path}: secret ${JSON.stringify(ref.name)} cannot be resolved by the host secret resolver`, path);
  }
}

/** Walks an adapter operation and validates every {ref}/{literal} binding shape and root. */
function checkOperationBindings(op: JsonValue, path: string, c: Collector, depth = 0): void {
  if (depth > 16 || !op || typeof op !== "object") return;
  if (Array.isArray(op)) {
    op.forEach((v, i) => checkOperationBindings(v, `${path}[${i}]`, c, depth + 1));
    return;
  }
  const o = op as JsonObject;
  if (("ref" in o && typeof o["ref"] === "string") || ("literal" in o && Object.keys(o).length === 1)) {
    const err = checkBinding(o, ["inputs"], path);
    if (err) c.add("INVALID_REFERENCE", err, path, "Tool operations may reference inputs.* only");
    return;
  }
  for (const [k, v] of Object.entries(o)) checkOperationBindings(v, `${path}.${k}`, c, depth + 1);
}

function effectOf(ref: string, tools: Record<string, EffectiveToolConfig>, codeTools: ToolDefinition[]): "read" | "write" | "destructive" {
  const id = ref.split("@")[0]!;
  const cfg = tools[id];
  if (cfg && cfg.ref === ref) return cfg.policy.effect;
  const code = codeTools.find((t) => t.ref === ref);
  return code?.policy.effect ?? "read";
}

function classificationRank(c: string): number {
  return ["public", "internal", "confidential", "restricted"].indexOf(c);
}

export function shorthandIdentity(kind: string, id: string, fields: string[], classification: BindingIdentity["classification"]): BindingIdentity {
  const revision = digestJson(fields).slice(7, 23);
  return { id: `${kind}:${id}`, revision, accountScope: fields[0] ?? id, classification };
}

function stripCredentials<T extends object>(rec: Record<string, T>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(rec)) {
    const copy = JSON.parse(JSON.stringify(v)) as JsonObject;
    delete copy["credential"];
    if (copy["auth"] && typeof copy["auth"] === "object") delete (copy["auth"] as JsonObject)["credential"];
    out[k] = copy;
  }
  return out;
}

function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out;
}
