/** Shared provider adapter helpers (§13.2, §13.6). */
import type { JsonObject, JsonSchema, JsonValue } from "../../types/common.js";
import type { ModelStreamError, NeutralMessage, NeutralModelRequest, Usage } from "../../types/model.js";
import type { ExposedTool } from "../../types/tool.js";
import { canonicalize } from "../../util/jcs.js";
import { estimateTokens } from "../../util/tokens.js";
import { digestJson } from "../../util/digest.js";

export const MAX_PROVIDER_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Tools sorted by alias so the serialization is byte-stable (§13.6). */
export function sortedTools(tools: ExposedTool[]): ExposedTool[] {
  return [...tools].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

/** Byte-stable body: canonical key order, no per-call values. */
export function stableBody(body: JsonValue): string {
  return canonicalize(body);
}

export function bodyDigest(body: string): string {
  return digestJson(body);
}

/** Estimated overhead of a tool definition on the wire. */
export function toolOverheadTokens(tool: { alias: string; description: string; inputSchema: JsonSchema }): number {
  return estimateTokens(JSON.stringify({ name: tool.alias, description: tool.description, parameters: tool.inputSchema })) + 8;
}

/** True when every object in the schema requires all its properties (provider-strict compatible). */
export function schemaIsStrictCompatible(schema: JsonSchema, depth = 0): boolean {
  if (depth > 32) return false;
  if (schema["type"] === "object") {
    const props = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
    const required = (schema["required"] ?? []) as string[];
    for (const [k, v] of Object.entries(props)) {
      if (!required.includes(k)) return false;
      if (!schemaIsStrictCompatible(v, depth + 1)) return false;
    }
    return schema["additionalProperties"] === false;
  }
  if (schema["type"] === "array" && schema["items"] && typeof schema["items"] === "object") return schemaIsStrictCompatible(schema["items"] as JsonSchema, depth + 1);
  if (Array.isArray(schema["anyOf"])) return (schema["anyOf"] as JsonSchema[]).every((s) => schemaIsStrictCompatible(s, depth + 1));
  return true;
}

export function estimateRequestTokens(request: NeutralModelRequest): number {
  let n = 0;
  for (const i of request.instructions) n += estimateTokens(i);
  for (const m of request.messages) n += estimateTokens(messageText(m)) + 4;
  for (const t of request.tools) n += t.tokens;
  return n;
}

export function messageText(m: NeutralMessage): string {
  if (m.role === "tool_results") return m.results.map((r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content))).join("\n");
  return m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? JSON.stringify(p.arguments) : p.type === "opaque" ? JSON.stringify(p.block) : "")).join("\n");
}

export function toolResultText(content: JsonValue): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

export interface HttpErrorInfo {
  status: number;
  body: string;
  retryAfterMs?: number;
}

/** Classifies a provider HTTP failure into a stream error with an explicit retry disposition (§13.4). */
export function classifyHttpError(info: HttpErrorInfo, providerMessage: string | undefined, providerType: string | undefined): ModelStreamError {
  const message = (providerMessage ?? info.body.slice(0, 300) ?? `HTTP ${info.status}`).replace(/[\r\n]+/g, " ");
  const base: ModelStreamError = { code: "PROVIDER_ERROR", message: `HTTP ${info.status}: ${message}`, retryable: false, status: info.status };
  if (info.retryAfterMs !== undefined) base.retryAfterMs = info.retryAfterMs;
  if (info.status === 429) return { ...base, code: "PROVIDER_RATE_LIMITED", retryable: true };
  if (info.status === 401 || info.status === 403) return { ...base, code: "PROVIDER_AUTH", retryable: false };
  if (info.status === 408 || info.status === 409 || info.status === 425) return { ...base, code: "PROVIDER_UNAVAILABLE", retryable: true };
  if (info.status >= 500) return { ...base, code: "PROVIDER_UNAVAILABLE", retryable: true };
  if (info.status === 400 && /too long|context length|maximum context|context_length_exceeded|token limit|exceeds the model/i.test(message)) {
    return { ...base, code: "CONTEXT_EXCEEDED", retryable: false };
  }
  if (providerType === "overloaded_error") return { ...base, code: "PROVIDER_UNAVAILABLE", retryable: true };
  return { ...base, code: "PROVIDER_REQUEST_REJECTED", retryable: false };
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    return "";
  }
}

export function safeJson(text: string): JsonObject | null {
  try {
    const v = JSON.parse(text) as JsonValue;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

export function estimatedUsage(inputTokens: number, outputText: string): Usage {
  return { inputTokens, outputTokens: estimateTokens(outputText), reported: false };
}

export function networkError(err: unknown, aborted: boolean): ModelStreamError {
  if (aborted) return { code: "CANCELLED", message: "cancelled", retryable: false };
  const msg = err instanceof Error ? err.message : String(err);
  return { code: "PROVIDER_UNAVAILABLE", message: `network: ${msg.replace(/[\r\n]+/g, " ").slice(0, 300)}`, retryable: true };
}
