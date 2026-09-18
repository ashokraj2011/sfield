/** Tool registry (§8). Every route produces the same internal ToolDefinition. */
import type { JsonObject } from "../types/common.js";
import type { DefineToolInput, ToolAdapter, ToolDefinition } from "../types/tool.js";
import type { EffectiveToolConfig, LockManifest } from "../config/types.js";
import { SFieldError } from "../errors.js";
import { FunctionAdapter } from "./function-adapter.js";
import { normalizeTool, type ToolSpec } from "./define-tool.js";
import { BUILTIN_TOOLS } from "./builtins.js";

export interface ToolDescription {
  ref: string;
  id: string;
  version: string;
  description: string;
  inputs: JsonObject;
  outputs: JsonObject;
  select?: string[];
  adapter: string;
  connection?: string;
  resource?: { type: string; id: unknown };
  policy: ToolDefinition["policy"];
  deduplication?: ToolDefinition["deduplication"];
  source: ToolDefinition["source"];
  digest: string;
  notes: string[];
}

export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();
  private readonly byId = new Map<string, ToolDefinition[]>();
  private readonly adapters = new Map<string, ToolAdapter>();
  readonly functionAdapter = new FunctionAdapter();
  private frozen = false;

  constructor() {
    this.adapters.set(this.functionAdapter.id, this.functionAdapter);
    for (const b of BUILTIN_TOOLS) this.put(b);
  }

  registerAdapter(adapter: ToolAdapter): void {
    if (this.adapters.has(adapter.id) && this.adapters.get(adapter.id) !== adapter) {
      throw new SFieldError("DUPLICATE_DEFINITION", `adapter ${adapter.id} registered twice`, { path: `adapters.${adapter.id}` });
    }
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): ToolAdapter | undefined {
    return this.adapters.get(id);
  }

  get adapterMap(): Map<string, ToolAdapter> {
    return this.adapters;
  }

  /** defineTool result, registerTool input, or bundle tool. */
  registerCode(input: ToolDefinition | DefineToolInput, source: ToolDefinition["source"] = "registerTool"): ToolDefinition {
    if (this.frozen) {
      throw new SFieldError("REGISTRATION_CLOSED", `cannot register ${(input as { id: string }).id} after the first run; the tool set is fixed by the lock manifest`, { suggestion: "Register tools before the first run" });
    }
    const def = "digest" in input && "ref" in input ? (input as ToolDefinition) : normalizeTool(input as ToolSpec, { source, defaultEffect: source === "config" ? undefined : "read" });
    if (!def.handler) throw new SFieldError("INVALID_CONFIG", `tools.${def.id}: code tools need a handler`, { path: `tools.${def.id}.handler` });
    this.put(def);
    this.functionAdapter.bind(def, def.handler);
    return def;
  }

  /** Adapter-backed tool from compiled configuration. */
  registerConfigured(cfg: EffectiveToolConfig): ToolDefinition {
    const existing = this.defs.get(cfg.ref);
    if (existing) {
      if (existing.digest !== cfg.digest) throw new SFieldError("DUPLICATE_TOOL", `${cfg.ref} already registered with a different definition`, { path: `tools.${cfg.id}` });
      return existing;
    }
    const def: ToolDefinition = {
      id: cfg.id,
      version: cfg.version,
      ref: cfg.ref,
      description: cfg.description,
      inputs: cfg.inputs,
      outputs: cfg.outputs,
      adapter: cfg.adapter,
      policy: {
        effect: cfg.policy.effect,
        action: cfg.policy.action,
        classification: cfg.policy.classification,
        timeoutMs: cfg.policy.timeout_ms,
        maxAttempts: cfg.policy.max_attempts,
        retrySafety: cfg.policy.retry_safety,
        maxOutputBytes: cfg.policy.max_output_bytes,
        requiresApproval: cfg.policy.requires_approval,
        costMicroUsd: cfg.policy.cost_microusd,
      },
      source: "config",
      digest: cfg.digest,
      notes: [],
    };
    if (cfg.select) def.outputSelect = cfg.select;
    if (cfg.connection) def.connection = cfg.connection;
    if (cfg.operation) def.operation = cfg.operation;
    if (cfg.resource) def.resource = cfg.resource;
    if (cfg.policy.prerequisite) def.policy.prerequisite = cfg.policy.prerequisite;
    if (cfg.policy.pollable) def.policy.pollable = { minIntervalMs: cfg.policy.pollable.min_interval_ms };
    if (cfg.policy.conflict_key) def.policy.conflictKey = cfg.policy.conflict_key;
    if (cfg.deduplication) def.deduplication = cfg.deduplication;
    if (cfg.extensions) def.extensions = cfg.extensions;
    this.put(def);
    return def;
  }

  private put(def: ToolDefinition): void {
    const existing = this.defs.get(def.ref);
    if (existing) {
      if (existing.digest !== def.digest) {
        throw new SFieldError("DUPLICATE_TOOL", `${def.ref} is registered twice with different definitions`, { path: `tools.${def.id}`, suggestion: "Register one implementation per id@version" });
      }
      return;
    }
    this.defs.set(def.ref, def);
    const list = this.byId.get(def.id) ?? [];
    list.push(def);
    list.sort((a, b) => a.version.localeCompare(b.version));
    this.byId.set(def.id, list);
  }

  freeze(): void {
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  has(ref: string): boolean {
    return this.defs.has(ref);
  }

  get(ref: string): ToolDefinition | undefined {
    return this.defs.get(ref);
  }

  /** `id@version` exact, or an unversioned id with exactly one eligible version (§5.4). */
  resolve(ref: string): ToolDefinition {
    const exact = this.defs.get(ref);
    if (exact) return exact;
    if (ref.includes("@")) throw new SFieldError("UNKNOWN_TOOL", `tool ${ref} is not registered`, { suggestion: `Registered: ${this.list().map((d) => d.ref).join(", ") || "none"}` });
    const versions = this.byId.get(ref) ?? [];
    if (versions.length === 0) throw new SFieldError("UNKNOWN_TOOL", `tool ${ref} is not registered`, { suggestion: `Registered: ${this.list().map((d) => d.ref).join(", ") || "none"}` });
    if (versions.length > 1) throw new SFieldError("AMBIGUOUS_TOOL_VERSION", `tool ${ref} has ${versions.length} versions; pin one`, { suggestion: `Use one of: ${versions.map((v) => v.ref).join(", ")}` });
    return versions[0]!;
  }

  /** All definitions in stable order by ref (built-ins included). */
  list(opts: { includeBuiltins?: boolean } = {}): ToolDefinition[] {
    return [...this.defs.values()].filter((d) => opts.includeBuiltins || d.source !== "builtin").sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  codeTools(): ToolDefinition[] {
    return this.list().filter((d) => d.source !== "config");
  }

  describe(ref: string): ToolDescription {
    const def = this.resolve(ref);
    const out: ToolDescription = {
      ref: def.ref,
      id: def.id,
      version: def.version,
      description: def.description,
      inputs: def.inputs as JsonObject,
      outputs: def.outputs as JsonObject,
      adapter: def.adapter,
      policy: def.policy,
      source: def.source,
      digest: def.digest,
      notes: def.notes,
    };
    if (def.outputSelect) out.select = def.outputSelect;
    if (def.connection) out.connection = def.connection;
    if (def.resource) out.resource = def.resource;
    if (def.deduplication) out.deduplication = def.deduplication;
    return out;
  }

  /** A different implementation under a locked id/version is rejected (§8.1). */
  verifyLock(lock: LockManifest): void {
    for (const [ref, entry] of Object.entries(lock.tools)) {
      const def = this.defs.get(ref);
      if (!def) throw new SFieldError("LOCK_MANIFEST_MISMATCH", `lock manifest pins ${ref}, which is not registered`, { suggestion: "Register the tool or rebuild the lock manifest" });
      if (def.digest !== entry.digest) throw new SFieldError("LOCK_MANIFEST_MISMATCH", `${ref} digest ${def.digest} differs from the lock manifest ${entry.digest}`, { suggestion: "Review the change and rebuild/approve the lock manifest" });
    }
  }
}
