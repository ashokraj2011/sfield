/** Tool definition normalization shared by config tools and code tools (§8.1, §8.3, §9.1). */
import type { JsonObject, ValueBinding } from "../types/common.js";
import type { DefineToolInput, ToolDefinition, ToolPolicy, ToolSource } from "../types/tool.js";
import { SFieldError } from "../errors.js";
import { digestJson } from "../util/digest.js";
import { TOOL_POLICY_DEFAULTS } from "../config/defaults.js";
import { sharedValidator } from "../schema/validator.js";
import { validateSelectPaths } from "../schema/select.js";
import { checkBinding } from "../util/refs.js";

export const TOOL_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
export const BUILTIN_TOOL_IDS: readonly string[] = Object.freeze(["ask_user", "memory.remember", "memory.forget"]);

/** The digest binds everything except the handler, source, and notes (§8.1). */
export function toolDigestInput(def: Omit<ToolDefinition, "digest" | "handler" | "source" | "notes" | "bundleId" | "buildDigest" | "ref">): JsonObject {
  return {
    id: def.id,
    version: def.version,
    description: def.description,
    inputs: def.inputs as JsonObject,
    outputs: def.outputs as JsonObject,
    select: def.outputSelect ?? null,
    adapter: def.adapter,
    connection: def.connection ?? null,
    operation: def.operation ?? null,
    resource: def.resource ? { type: def.resource.type, id: def.resource.id as unknown as JsonObject } : null,
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
      prerequisite: def.policy.prerequisite ?? null,
      pollable: def.policy.pollable ? { min_interval_ms: def.policy.pollable.minIntervalMs } : null,
      conflict_key: (def.policy.conflictKey as unknown as JsonObject) ?? null,
    },
    deduplication: (def.deduplication as unknown as JsonObject) ?? null,
    extensions: def.extensions ?? null,
  };
}

/** Internal superset of DefineToolInput: configured tools carry an adapter operation instead of a handler. */
export type ToolSpec = Omit<DefineToolInput, "handler"> & {
  handler?: DefineToolInput["handler"];
  adapter?: string;
  connection?: string;
  operation?: JsonObject;
};

export interface NormalizeOptions {
  source: ToolSource;
  /** registerTool defaults effect to read; configured tools require it. */
  defaultEffect?: "read";
  bundleId?: string;
  buildDigest?: string;
}

/**
 * Validates and normalizes a tool definition. Throws SFieldError with a config path on failure.
 * Read tools without a resource receive `{type: "tool", id}` with a validation note (§9.1).
 */
export function normalizeTool(input: ToolSpec, opts: NormalizeOptions): ToolDefinition {
  const path = `tools.${input.id ?? "?"}`;
  const notes: string[] = [];
  if (typeof input.id !== "string" || !TOOL_ID_RE.test(input.id)) {
    throw new SFieldError("INVALID_CONFIG", `${path}: tool id must be lowercase dot-separated segments`, { path, suggestion: "Example: orders.get" });
  }
  if (typeof input.version !== "string" || !SEMVER_RE.test(input.version)) {
    throw new SFieldError("INVALID_CONFIG", `${path}.version: must be an exact semantic version`, { path: `${path}.version`, suggestion: "Example: 1.0.0" });
  }
  if (BUILTIN_TOOL_IDS.includes(input.id)) {
    throw new SFieldError("DUPLICATE_TOOL", `${path}: ${input.id} is a built-in interaction tool and cannot be redefined`, { path });
  }
  if (typeof input.description !== "string" || input.description.trim().length === 0) {
    throw new SFieldError("INVALID_CONFIG", `${path}.description: required`, { path: `${path}.description` });
  }
  const validator = sharedValidator();
  const inputIssues = validator.check(input.inputs, { path: `${path}.inputs`, requireClosedObjects: true });
  if (inputIssues.length > 0) {
    const first = inputIssues[0]!;
    throw new SFieldError(first.code, first.message, { path: first.path, suggestion: first.suggestion, details: { issues: inputIssues.map((i) => `${i.path}: ${i.message}`) } });
  }
  if (!input.outputs || typeof input.outputs !== "object") {
    throw new SFieldError("INVALID_CONFIG", `${path}.outputs: required`, { path: `${path}.outputs` });
  }
  let outputs = input.outputs;
  let select = input.select;
  if (Object.prototype.hasOwnProperty.call(outputs, "select")) {
    const s = (outputs as Record<string, unknown>)["select"];
    const err = validateSelectPaths(s);
    if (err) throw new SFieldError("INVALID_CONFIG", `${path}.outputs.select: ${err}`, { path: `${path}.outputs.select` });
    select = s as string[];
    const rest = { ...outputs };
    delete rest["select"];
    outputs = rest;
  } else if (select !== undefined) {
    const err = validateSelectPaths(select);
    if (err) throw new SFieldError("INVALID_CONFIG", `${path}.select: ${err}`, { path: `${path}.select` });
  }
  const outputIssues = validator.check(outputs, { path: `${path}.outputs`, requireClosedObjects: true });
  if (outputIssues.length > 0) {
    const first = outputIssues[0]!;
    throw new SFieldError(first.code, first.message, { path: first.path, suggestion: first.suggestion, details: { issues: outputIssues.map((i) => `${i.path}: ${i.message}`) } });
  }
  if (select) {
    const props = (outputs["properties"] ?? {}) as Record<string, unknown>;
    for (const p of select) {
      const head = p.split(".")[0]!;
      if (!Object.prototype.hasOwnProperty.call(props, head)) {
        throw new SFieldError("INVALID_CONFIG", `${path}.outputs.select: selected field ${JSON.stringify(head)} is not declared in the outputs schema`, { path: `${path}.outputs.select` });
      }
    }
  }

  const p = input.policy ?? {};
  let action = p.action;
  let resource = input.resource;
  if (input.authorization) {
    if (action !== undefined && action !== input.authorization.action) {
      throw new SFieldError("INVALID_CONFIG", `${path}: authorization.action conflicts with policy.action`, { path });
    }
    action = input.authorization.action;
    if (input.authorization.resource) {
      if (resource !== undefined) throw new SFieldError("INVALID_CONFIG", `${path}: declare resource once (authorization.resource or resource)`, { path });
      resource = input.authorization.resource;
    }
  }
  const effect = p.effect ?? opts.defaultEffect;
  if (effect === undefined) {
    throw new SFieldError("INVALID_CONFIG", `${path}.policy.effect: required (read, write, or destructive)`, { path: `${path}.policy.effect`, suggestion: "Declare the business impact of the tool in one word" });
  }
  if (effect !== "read" && effect !== "write" && effect !== "destructive") {
    throw new SFieldError("INVALID_CONFIG", `${path}.policy.effect: must be read, write, or destructive`, { path: `${path}.policy.effect` });
  }
  if (resource) {
    if (typeof resource.type !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(resource.type)) {
      throw new SFieldError("INVALID_CONFIG", `${path}.resource.type: invalid`, { path: `${path}.resource.type` });
    }
    const err = checkBinding(resource.id, ["inputs", "environment"], `${path}.resource.id`);
    if (err) throw new SFieldError("INVALID_REFERENCE", err, { path: `${path}.resource.id` });
  } else if (effect === "read") {
    resource = { type: "tool", id: { literal: input.id } };
    notes.push(`${path}.resource: read tool without a resource; defaulted to {type: tool, id: ${input.id}} (§9.1)`);
  } else {
    throw new SFieldError("INVALID_CONFIG", `${path}.resource: required for ${effect} tools`, { path: `${path}.resource`, suggestion: "Declare the business resource the mutation acts on, e.g. {type: order, id: {ref: inputs.order_id}}" });
  }
  const retrySafety = p.retrySafety ?? TOOL_POLICY_DEFAULTS.retry_safety;
  const maxAttempts = p.maxAttempts ?? TOOL_POLICY_DEFAULTS.max_attempts;
  if (maxAttempts > 1 && retrySafety === "never") {
    throw new SFieldError("INVALID_CONFIG", `${path}.policy.max_attempts: ${maxAttempts} requires retry_safety repeatable or deduplicated`, { path: `${path}.policy.max_attempts`, suggestion: "Declare retry_safety, or keep max_attempts at 1" });
  }
  if (retrySafety === "deduplicated" && !input.deduplication) {
    throw new SFieldError("INVALID_CONFIG", `${path}.policy.retry_safety: deduplicated requires a deduplication contract`, { path: `${path}.deduplication` });
  }
  if (p.pollable && effect !== "read") {
    throw new SFieldError("INVALID_CONFIG", `${path}.policy.pollable: only read tools may be pollable`, { path: `${path}.policy.pollable` });
  }
  if (p.conflictKey) {
    const err = checkBinding(p.conflictKey, ["inputs"], `${path}.policy.conflict_key`);
    if (err) throw new SFieldError("INVALID_REFERENCE", err, { path: `${path}.policy.conflict_key` });
  }
  const policy: ToolPolicy = {
    effect,
    action: action ?? input.id,
    classification: p.classification ?? TOOL_POLICY_DEFAULTS.classification,
    timeoutMs: p.timeoutMs ?? TOOL_POLICY_DEFAULTS.timeout_ms,
    maxAttempts,
    retrySafety,
    maxOutputBytes: p.maxOutputBytes ?? TOOL_POLICY_DEFAULTS.max_output_bytes,
    requiresApproval: p.requiresApproval ?? TOOL_POLICY_DEFAULTS.requires_approval,
    costMicroUsd: p.costMicroUsd ?? TOOL_POLICY_DEFAULTS.cost_microusd,
  };
  if (p.prerequisite) policy.prerequisite = p.prerequisite;
  if (p.pollable) policy.pollable = { minIntervalMs: p.pollable.minIntervalMs };
  if (p.conflictKey) policy.conflictKey = p.conflictKey as ValueBinding;

  const adapter = input.adapter ?? "function";
  if (adapter === "function" && typeof input.handler !== "function") {
    throw new SFieldError("INVALID_CONFIG", `${path}.adapter: configured tools must name an adapter (function tools need a handler)`, { path: `${path}.adapter`, suggestion: "Example: adapter: http with a connection and operation" });
  }
  if (adapter !== "function" && typeof input.handler === "function") {
    throw new SFieldError("INVALID_CONFIG", `${path}: a tool has either a handler or an adapter operation, not both`, { path });
  }
  const base = {
    id: input.id,
    version: input.version,
    description: input.description,
    inputs: input.inputs,
    outputs,
    outputSelect: select,
    adapter,
    connection: input.connection,
    operation: input.operation,
    resource,
    policy,
    deduplication: input.deduplication,
    extensions: input.extensions,
  };
  const def: ToolDefinition = {
    ...base,
    ref: `${input.id}@${input.version}`,
    handler: input.handler,
    source: opts.source,
    digest: digestJson(toolDigestInput(base)),
    notes,
  };
  if (opts.bundleId) def.bundleId = opts.bundleId;
  if (opts.buildDigest) def.buildDigest = opts.buildDigest;
  return def;
}

/** Public helper (§8.3). */
export function defineTool(input: DefineToolInput): ToolDefinition {
  if (typeof input.handler !== "function") {
    throw new SFieldError("INVALID_CONFIG", `tools.${input.id}: defineTool requires a handler`, { path: `tools.${input.id}.handler` });
  }
  return normalizeTool(input, { source: "bundle", defaultEffect: "read" });
}
