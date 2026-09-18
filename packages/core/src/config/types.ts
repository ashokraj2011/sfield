/** Effective configuration shapes (§5). */
import type { DataClassification, JsonObject, JsonSchema, SecretRef, ValueBinding, BindingIdentity } from "../types/common.js";
import type { DeduplicationContract, ToolSource } from "../types/tool.js";

export interface EffectiveModelConfig {
  id: string;
  form: "binding" | "shorthand";
  binding?: string;
  provider?: string;
  model?: string;
  credential?: SecretRef;
  base_url?: string;
  params: JsonObject;
  fallback?: string;
  quirks?: string[];
  limits?: { context_window?: number; max_output_tokens?: number };
  classification?: DataClassification;
  prices?: { version: string; input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok?: number; cache_write_per_mtok?: number };
  api_version?: string;
}

export interface EffectiveConnectionConfig {
  id: string;
  base_url: string;
  auth?: { type: "bearer" | "header" | "basic"; credential: SecretRef; name?: string };
  allowed_hosts: string[];
  classification: DataClassification;
  timeout_ms: number;
  headers?: Record<string, string>;
}

export interface EffectiveSourceConfig {
  id: string;
  form: "binding" | "type";
  binding?: string;
  type?: string;
  config: JsonObject;
}

export interface EffectiveToolPolicy {
  effect: "read" | "write" | "destructive";
  action: string;
  classification: DataClassification;
  timeout_ms: number;
  max_attempts: number;
  retry_safety: "never" | "repeatable" | "deduplicated";
  max_output_bytes: number;
  requires_approval: boolean;
  cost_microusd: number;
  prerequisite?: string;
  pollable?: { min_interval_ms: number };
  conflict_key?: ValueBinding;
}

export interface EffectiveToolConfig {
  id: string;
  version: string;
  ref: string;
  description: string;
  adapter: string;
  connection?: string;
  operation?: JsonObject;
  inputs: JsonSchema;
  outputs: JsonSchema;
  select?: string[];
  resource?: { type: string; id: ValueBinding };
  policy: EffectiveToolPolicy;
  deduplication?: DeduplicationContract;
  extensions?: JsonObject;
  digest: string;
}

export interface EffectiveContextSource {
  source: string;
  query: ValueBinding;
  max_items: number;
  max_tokens: number;
  required: boolean;
  timeout_ms: number;
  filters?: JsonObject;
  max_age_seconds?: number;
}

export type ContextPriority = "history" | "preferences" | "facts" | "retrieval" | "summary";

export interface EffectiveAgentConfig {
  id: string;
  model: string;
  instructions: string;
  instructions_source?: string;
  /** Pinned `id@version` refs in configured order. */
  tools: string[];
  memory: {
    conversation: boolean;
    preferences: "off" | "explicit";
    facts: "off" | "explicit";
    retention_days: { conversation: number; preferences: number; facts: number };
  };
  context: {
    max_input_tokens: number;
    output_reserve_tokens: number;
    max_tools: number;
    sources: EffectiveContextSource[];
    summarizer?: string;
    priority: ContextPriority[];
  };
  policy: { preset: "read_only" | "supervised" | "bounded_auto" };
  budget: {
    max_turns: number;
    max_model_calls: number;
    max_provider_attempts: number;
    max_tool_calls: number;
    max_tool_attempts: number;
    max_tokens: number;
    max_cost_microusd: number;
    max_active_seconds: number;
    max_elapsed_seconds: number;
  };
  output: { schema?: JsonSchema; verifier?: string; max_repairs: number; stream: boolean };
  runtime: {
    loop_detection: {
      enabled: boolean;
      identical_call_window: number;
      on_first: "warn" | "fail";
      on_repeat: "fail" | "warn";
      max_polls_per_run: number;
    };
  };
  extensions: JsonObject;
}

export interface LockManifest {
  version: 1;
  configDigest: string;
  tools: Record<string, { ref: string; digest: string; source: ToolSource }>;
  plugins: Record<string, { version: string; buildDigest: string }>;
  bindings: Record<string, { kind: "model" | "connection" | "retrieval"; identity: BindingIdentity }>;
  schemaVersion: 1;
  compilerVersion: string;
  formats: string;
}

export interface ConfigNote {
  path: string;
  code: string;
  message: string;
}

export interface EffectiveConfig {
  version: 1;
  models: Record<string, EffectiveModelConfig>;
  connections: Record<string, EffectiveConnectionConfig>;
  sources: Record<string, EffectiveSourceConfig>;
  tools: Record<string, EffectiveToolConfig>;
  agents: Record<string, EffectiveAgentConfig>;
  extensions: JsonObject;
  digest: string;
  lock: LockManifest;
  provenance: Record<string, string>;
  notes: ConfigNote[];
  configDir: string;
  schemaVersion: 1;
  compilerVersion: string;
}

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const COMPILER_VERSION = "sfield-compiler@0.1.0";
