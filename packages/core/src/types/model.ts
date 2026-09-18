/** Model gateway contracts (§13). */
import type { BindingIdentity, DataClassification, JsonObject, JsonSchema, JsonValue, SecretRef } from "./common.js";
import type { ExposedTool } from "./tool.js";
import type { SecretResolver } from "./options.js";

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

/** Prices in micro-USD per million tokens (§15.1). */
export interface PriceTable {
  version: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export type OpenAIQuirk = "system_as_user" | "no_stream_usage" | "no_strict" | "json_mode_only" | "tool_choice_unsupported";

export interface ModelBinding {
  identity: BindingIdentity;
  provider: string;
  model: string;
  baseUrl?: string;
  credential?: SecretRef;
  /** Highest data classification this route accepts (§18.1). */
  acceptsClassification: DataClassification;
  limits: ModelLimits;
  prices?: PriceTable;
  params?: JsonObject;
  supportedParams: readonly string[];
  quirks?: readonly OpenAIQuirk[];
  fallback?: string;
  /** Trusted static headers (never model-driven). */
  headers?: Record<string, string>;
  /** Anthropic API version header. */
  apiVersion?: string;
}

export interface ModelCapabilities {
  inputLimit: number;
  outputLimit: number;
  toolUse: boolean;
  structuredOutput: "json_schema" | "json_mode" | "none";
  strictTools: boolean;
  streamingUsage: boolean;
  media: string[];
  opaqueContinuation: boolean;
  tokenCounting: "provider" | "estimated";
  continueStopReason: boolean;
}

export type NeutralPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; toolRef: string; alias: string; arguments: JsonObject; providerCallId?: string }
  | { type: "opaque"; provider: string; block: JsonObject }
  | { type: "media"; mediaType: string; ref: string; text?: string };

export interface NeutralToolResult {
  callId: string;
  alias: string;
  providerCallId?: string;
  content: JsonValue;
  isError: boolean;
}

export type NeutralMessage =
  | { role: "user"; parts: NeutralPart[] }
  | { role: "assistant"; parts: NeutralPart[] }
  /** One logical result batch (§13.2). */
  | { role: "tool_results"; results: NeutralToolResult[] };

export interface NeutralModelRequest {
  binding: ModelBinding;
  /** Trusted instruction channel, in order. */
  instructions: string[];
  messages: NeutralMessage[];
  tools: ExposedTool[];
  outputSchema?: JsonSchema;
  params: {
    maxOutputTokens: number;
    temperature?: number;
    stopSequences?: string[];
    topP?: number;
  };
  toolChoice: "auto" | "none";
}

export interface CompiledModelRequest {
  provider: string;
  url: string;
  method: "POST";
  /** Non-secret headers. Secret headers are resolved at dispatch and never stored. */
  headers: Record<string, string>;
  /** Byte-stable body (§13.6). */
  body: string;
  aliasMap: Record<string, string>;
  overheadTokens: number;
  degradations: string[];
  equivalence: { toolsExact: boolean; schemaExact: boolean; notes: string[] };
  digest: string;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "continue"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "content_filter"
  | "context_exceeded"
  | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Whether the counts were reported by the provider (true) or estimated (false). */
  reported: boolean;
  providerRequestId?: string;
}

export interface ModelStreamError {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; alias: string; providerCallId?: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "opaque"; block: JsonObject }
  | {
      type: "done";
      message: Extract<NeutralMessage, { role: "assistant" }>;
      stopReason: StopReason;
      usage: Usage;
      stopSequence?: string;
    }
  | { type: "error"; error: ModelStreamError };

export interface ModelProvider {
  id: string;
  describe(binding: ModelBinding): Promise<ModelCapabilities>;
  compile(request: NeutralModelRequest): Promise<CompiledModelRequest>;
  stream(
    request: CompiledModelRequest,
    opts: { signal: AbortSignal; attemptId: string; secrets: SecretResolver; binding: ModelBinding },
  ): AsyncIterable<ModelStreamEvent>;
  countTokens?(request: CompiledModelRequest, opts: { secrets: SecretResolver; binding: ModelBinding }): Promise<number>;
}

export interface ModelAttemptRecord {
  attemptId: string;
  modelBindingId: string;
  model: string;
  startedAt: string;
  durationMs: number;
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  stopReason?: StopReason;
  usage?: Usage;
  costMicroUsd?: number;
  priceVersion?: string;
  error?: ModelStreamError;
  providerRequestId?: string;
  compiledDigest: string;
}
