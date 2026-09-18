/** Root configuration schema (§5.1). Validated with the full draft 2020-12 validator; tool schemas use the subset. */
import type { JsonSchema } from "../types/common.js";

const valueBinding: JsonSchema = {
  type: "object",
  oneOf: [
    { type: "object", required: ["literal"], additionalProperties: false, properties: { literal: {} } },
    {
      type: "object",
      required: ["ref"],
      additionalProperties: false,
      properties: { ref: { type: "string", minLength: 1, maxLength: 512 }, onMissing: { type: "string", enum: ["error", "omit"] } },
    },
  ],
};

const secretRef: JsonSchema = {
  type: "object",
  oneOf: [
    { type: "object", required: ["env"], additionalProperties: false, properties: { env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } } },
    { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1 } } },
  ],
};

const classification: JsonSchema = { type: "string", enum: ["public", "internal", "confidential", "restricted"] };
const semver: JsonSchema = { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$" };
const toolId: JsonSchema = { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$", maxLength: 128 };
const name: JsonSchema = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_-]*$", maxLength: 128 };
const nonNegInt: JsonSchema = { type: "integer", minimum: 0 };
const posInt: JsonSchema = { type: "integer", minimum: 1 };

const model: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    binding: name,
    provider: name,
    model: { type: "string", minLength: 1 },
    credential: secretRef,
    base_url: { type: "string", minLength: 1 },
    params: { type: "object", additionalProperties: true },
    fallback: name,
    quirks: { type: "array", items: { type: "string", enum: ["system_as_user", "no_stream_usage", "no_strict", "json_mode_only", "tool_choice_unsupported"] }, uniqueItems: true },
    limits: { type: "object", additionalProperties: false, properties: { context_window: posInt, max_output_tokens: posInt } },
    classification,
    prices: {
      type: "object",
      additionalProperties: false,
      required: ["version", "input_per_mtok", "output_per_mtok"],
      properties: { version: { type: "string" }, input_per_mtok: nonNegInt, output_per_mtok: nonNegInt, cache_read_per_mtok: nonNegInt, cache_write_per_mtok: nonNegInt },
    },
    api_version: { type: "string" },
  },
};

const connection: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["base_url"],
  properties: {
    base_url: { type: "string", minLength: 1 },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["type", "credential"],
      properties: { type: { type: "string", enum: ["bearer", "header", "basic"] }, credential: secretRef, name: { type: "string", minLength: 1 } },
    },
    allowed_hosts: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    classification,
    timeout_ms: posInt,
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
};

const source: JsonSchema = {
  type: "object",
  properties: { binding: name, type: name },
  additionalProperties: true,
};

const toolPolicy: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    effect: { type: "string", enum: ["read", "write", "destructive"] },
    action: { type: "string", minLength: 1, maxLength: 128 },
    classification,
    timeout_ms: posInt,
    max_attempts: posInt,
    retry_safety: { type: "string", enum: ["never", "repeatable", "deduplicated"] },
    max_output_bytes: posInt,
    requires_approval: { type: "boolean" },
    cost_microusd: nonNegInt,
    prerequisite: name,
    pollable: { type: "object", additionalProperties: false, required: ["min_interval_ms"], properties: { min_interval_ms: posInt } },
    conflict_key: valueBinding,
  },
};

const tool: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "description", "inputs", "outputs"],
  properties: {
    version: semver,
    description: { type: "string", minLength: 1, maxLength: 2000 },
    adapter: name,
    connection: name,
    operation: { type: "object" },
    inputs: { type: "object" },
    outputs: { type: "object" },
    resource: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: name, id: valueBinding } },
    authorization: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string" }, resource: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: name, id: valueBinding } } } },
    policy: toolPolicy,
    deduplication: {
      type: "object",
      additionalProperties: false,
      required: ["key_location", "scope", "retention_seconds", "payload_mismatch"],
      properties: {
        key_location: {
          type: "object",
          oneOf: [
            { type: "object", additionalProperties: false, required: ["header"], properties: { header: { type: "string", minLength: 1 } } },
            { type: "object", additionalProperties: false, required: ["body_field"], properties: { body_field: { type: "string", minLength: 1 } } },
            { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 } } },
          ],
        },
        scope: { type: "string", minLength: 1 },
        retention_seconds: posInt,
        payload_mismatch: { type: "string", enum: ["reject", "ignore"] },
        reconcile_binding: name,
      },
    },
    extensions: { type: "object" },
  },
};

const contextSource: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: {
    source: name,
    query: valueBinding,
    max_items: posInt,
    max_tokens: posInt,
    required: { type: "boolean" },
    timeout_ms: posInt,
    filters: { type: "object" },
    max_age_seconds: posInt,
  },
};

const agent: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    model: name,
    instructions: { type: "string", minLength: 1, maxLength: 200000 },
    instructions_file: { type: "string", minLength: 1 },
    tools: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    memory: {
      type: "object",
      additionalProperties: false,
      properties: {
        conversation: { type: "boolean" },
        preferences: { type: "string", enum: ["off", "explicit"] },
        facts: { type: "string", enum: ["off", "explicit"] },
        retention_days: { type: "object", additionalProperties: false, properties: { conversation: posInt, preferences: posInt, facts: posInt } },
      },
    },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_input_tokens: posInt,
        output_reserve_tokens: posInt,
        max_tools: posInt,
        sources: { type: "array", items: contextSource },
        summarizer: name,
        priority: { type: "array", items: { type: "string", enum: ["history", "preferences", "facts", "retrieval", "summary"] }, uniqueItems: true },
      },
    },
    policy: { type: "object", additionalProperties: false, properties: { preset: { type: "string", enum: ["read_only", "supervised", "bounded_auto"] } } },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_turns: posInt,
        max_model_calls: posInt,
        max_provider_attempts: posInt,
        max_tool_calls: nonNegInt,
        max_tool_attempts: nonNegInt,
        max_tokens: posInt,
        max_cost_microusd: nonNegInt,
        max_active_seconds: posInt,
        max_elapsed_seconds: posInt,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: { schema: { type: "object" }, verifier: name, max_repairs: nonNegInt, stream: { type: "boolean" } },
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        loop_detection: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            identical_call_window: { type: "integer", minimum: 2, maximum: 20 },
            on_first: { type: "string", enum: ["warn", "fail"] },
            on_repeat: { type: "string", enum: ["fail", "warn"] },
            max_polls_per_run: nonNegInt,
          },
        },
      },
    },
    extensions: { type: "object" },
  },
};

export const ROOT_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { type: "integer", const: 1 },
    includes: { type: "array", items: { type: "string", minLength: 1 } },
    models: { type: "object", propertyNames: name, additionalProperties: model },
    connections: { type: "object", propertyNames: name, additionalProperties: connection },
    sources: { type: "object", propertyNames: name, additionalProperties: source },
    tools: { type: "object", propertyNames: toolId, additionalProperties: tool },
    agents: { type: "object", propertyNames: name, additionalProperties: agent },
    extensions: { type: "object", propertyNames: name, additionalProperties: { type: "object" } },
  },
};

/** Fields permitted to carry `${env:NAME}` (§5.5), as path patterns with `*` for dictionary keys. */
export const ENV_SUBSTITUTABLE_PATHS: readonly string[] = Object.freeze(["models.*.model", "models.*.base_url", "connections.*.base_url", "sources.*.path"]);

export const ROOT_KEYS: readonly string[] = Object.freeze(["version", "includes", "models", "connections", "sources", "tools", "agents", "extensions"]);
export const DICTIONARY_KEYS: readonly string[] = Object.freeze(["models", "connections", "sources", "tools", "agents", "extensions"]);
