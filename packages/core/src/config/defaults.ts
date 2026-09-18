/** Default values (§22), materialized before hashing. */
import type { JsonObject, JsonValue } from "../types/common.js";

export const AGENT_DEFAULTS = Object.freeze({
  model: "default",
  tools: [] as string[],
  memory: {
    conversation: true,
    preferences: "off" as const,
    facts: "off" as const,
    retention_days: { conversation: 30, preferences: 365, facts: 30 },
  },
  context: {
    max_input_tokens: 12000,
    output_reserve_tokens: 2000,
    max_tools: 24,
    sources: [] as JsonValue[],
    priority: ["history", "preferences", "facts", "retrieval", "summary"] as const,
  },
  policy: { preset: "supervised" as const },
  budget: {
    max_turns: 20,
    max_model_calls: 30,
    max_provider_attempts: 40,
    max_tool_calls: 50,
    max_tool_attempts: 60,
    max_tokens: 200000,
    max_cost_microusd: 1000000,
    max_active_seconds: 300,
    max_elapsed_seconds: 86400,
  },
  output: { max_repairs: 1, stream: true },
  runtime: {
    loop_detection: { enabled: true, identical_call_window: 3, on_first: "warn" as const, on_repeat: "fail" as const, max_polls_per_run: 20 },
  },
});

export const CONTEXT_SOURCE_DEFAULTS = Object.freeze({
  query: { ref: "message.text" },
  max_items: 5,
  max_tokens: 2000,
  timeout_ms: 3000,
  required: false,
});

export const TOOL_POLICY_DEFAULTS = Object.freeze({
  classification: "internal" as const,
  timeout_ms: 10000,
  max_attempts: 1,
  retry_safety: "never" as const,
  max_output_bytes: 65536,
  requires_approval: false,
  cost_microusd: 0,
});

export const CONNECTION_DEFAULTS = Object.freeze({
  classification: "internal" as const,
  timeout_ms: 10000,
});

export const HOST_DEFAULTS = Object.freeze({
  approvalExpirySeconds: 3600,
  inputExpirySeconds: 86400,
  inlineResultLimitBytes: 65536,
  modelViewLimitBytes: 16384,
  idempotencyRetentionDays: 7,
  memoryCaps: { preferences: 500, facts: 1000 },
  concurrency: { readsPerRun: 4, mutationsPerRun: 1 },
  eventRetention: 10000,
  loopDetection: { minWindow: 2, maxWindow: 20, allowDisable: false, maxPollsPerRun: 100 },
  requestMaxBytes: 1024 * 1024,
});

/** Deep-fills missing keys from defaults; records inserted paths in provenance as "default". */
export function fillDefaults(target: JsonObject, defaults: Record<string, unknown>, path: string, provenance: Record<string, string>): JsonObject {
  const out: JsonObject = { ...target };
  for (const [k, dv] of Object.entries(defaults)) {
    const childPath = path ? `${path}.${k}` : k;
    if (!Object.prototype.hasOwnProperty.call(out, k) || out[k] === undefined) {
      out[k] = JSON.parse(JSON.stringify(dv)) as JsonValue;
      markDefault(out[k] as JsonValue, childPath, provenance);
      continue;
    }
    const cur = out[k];
    if (dv && typeof dv === "object" && !Array.isArray(dv) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = fillDefaults(cur as JsonObject, dv as Record<string, unknown>, childPath, provenance);
    }
  }
  return out;
}

function markDefault(value: JsonValue, path: string, provenance: Record<string, string>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) provenance[path] = "default";
    for (const [k, v] of Object.entries(value)) markDefault(v, `${path}.${k}`, provenance);
    return;
  }
  provenance[path] = "default";
}
