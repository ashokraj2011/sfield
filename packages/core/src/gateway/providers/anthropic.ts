/** Anthropic Messages API adapter over fetch + SSE (§13.6). */
import type { JsonObject, JsonValue } from "../../types/common.js";
import type { SecretResolver } from "../../types/options.js";
import type { CompiledModelRequest, ModelBinding, ModelCapabilities, ModelProvider, ModelStreamEvent, NeutralMessage, NeutralModelRequest, NeutralPart, StopReason, Usage } from "../../types/model.js";
import { parseSSE, SSEByteLimitError } from "../../util/sse.js";
import { estimateTokens } from "../../util/tokens.js";
import {
  MAX_PROVIDER_STREAM_BYTES,
  bodyDigest,
  classifyHttpError,
  estimateRequestTokens,
  networkError,
  parseRetryAfter,
  readErrorBody,
  safeJson,
  schemaIsStrictCompatible,
  sortedTools,
  stableBody,
  toolResultText,
} from "./shared.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_API_VERSION = "2023-06-01";

const STOP_MAP: Record<string, StopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  pause_turn: "continue",
  refusal: "refusal",
  model_context_window_exceeded: "context_exceeded",
};

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async describe(binding: ModelBinding): Promise<ModelCapabilities> {
    return {
      inputLimit: binding.limits.contextWindow,
      outputLimit: binding.limits.maxOutputTokens,
      toolUse: true,
      structuredOutput: "json_schema",
      strictTools: true,
      streamingUsage: true,
      media: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"],
      opaqueContinuation: true,
      tokenCounting: "provider",
      continueStopReason: true,
    };
  }

  async compile(request: NeutralModelRequest): Promise<CompiledModelRequest> {
    const binding = request.binding;
    const degradations: string[] = [];
    const notes: string[] = [];
    const tools = sortedTools(request.tools);
    const aliasMap: Record<string, string> = {};
    const wireTools: JsonValue[] = [];
    for (const t of tools) {
      aliasMap[t.alias] = t.ref;
      const strict = schemaIsStrictCompatible(t.inputSchema);
      if (!strict) notes.push(`${t.ref}: optional properties; strict tool schema not requested, local validation applies`);
      const def: JsonObject = { name: t.alias, description: t.description, input_schema: t.inputSchema as JsonObject };
      if (strict) def["strict"] = true;
      wireTools.push(def);
    }
    const system: JsonValue[] = request.instructions.map((text, i): JsonObject =>
      i === request.instructions.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text },
    );
    const messages = compileMessages(request.messages);
    const body: JsonObject = {
      model: binding.model,
      max_tokens: request.params.maxOutputTokens,
      system,
      messages,
      stream: true,
    };
    if (wireTools.length) {
      body["tools"] = wireTools;
      body["tool_choice"] = request.toolChoice === "none" ? { type: "none" } : { type: "auto" };
    }
    if (request.params.temperature !== undefined) body["temperature"] = request.params.temperature;
    if (request.params.topP !== undefined) body["top_p"] = request.params.topP;
    if (request.params.stopSequences?.length) body["stop_sequences"] = request.params.stopSequences;
    if (typeof binding.params?.["top_k"] === "number") body["top_k"] = binding.params["top_k"];
    if (request.outputSchema) body["output_config"] = { format: { type: "json_schema", schema: request.outputSchema as JsonObject } };
    const serialized = stableBody(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": binding.apiVersion ?? ANTHROPIC_API_VERSION,
      ...(binding.headers ?? {}),
    };
    return {
      provider: this.id,
      url: `${(binding.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/$/, "")}/v1/messages`,
      method: "POST",
      headers,
      body: serialized,
      aliasMap,
      overheadTokens: tools.reduce((n, t) => n + t.tokens, 0),
      degradations,
      equivalence: { toolsExact: true, schemaExact: true, notes },
      digest: bodyDigest(serialized),
    };
  }

  async countTokens(request: CompiledModelRequest, opts: { secrets: SecretResolver; binding: ModelBinding }): Promise<number> {
    const body = JSON.parse(request.body) as JsonObject;
    delete body["stream"];
    delete body["max_tokens"];
    const res = await this.fetchImpl(request.url.replace(/\/v1\/messages$/, "/v1/messages/count_tokens"), {
      method: "POST",
      headers: { ...request.headers, accept: "application/json", "x-api-key": await resolveKey(opts) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
    const json = (await res.json()) as { input_tokens: number };
    return json.input_tokens;
  }

  async *stream(request: CompiledModelRequest, opts: { signal: AbortSignal; attemptId: string; secrets: SecretResolver; binding: ModelBinding }): AsyncIterable<ModelStreamEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(request.url, {
        method: "POST",
        headers: { ...request.headers, "x-api-key": await resolveKey(opts) },
        body: request.body,
        signal: opts.signal,
      });
    } catch (err) {
      yield { type: "error", error: networkError(err, opts.signal.aborted) };
      return;
    }
    if (!res.ok) {
      const text = await readErrorBody(res);
      const json = safeJson(text);
      const errObj = json && typeof json["error"] === "object" ? (json["error"] as JsonObject) : null;
      yield { type: "error", error: classifyHttpError({ status: res.status, body: text, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) }, errObj?.["message"] as string | undefined, errObj?.["type"] as string | undefined) };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: { code: "PROVIDER_UNAVAILABLE", message: "empty response body", retryable: true } };
      return;
    }
    const blocks = new Map<number, { type: string; text: string; json: string; id?: string; name?: string; thinking: string; signature: string; data?: string }>();
    let stopReason: StopReason = "end_turn";
    let stopSequence: string | undefined;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, reported: true };
    let sawStop = false;
    try {
      for await (const msg of parseSSE(res.body, { maxBytes: MAX_PROVIDER_STREAM_BYTES, signal: opts.signal })) {
        if (!msg.data) continue;
        const data = safeJson(msg.data);
        if (!data) continue;
        const type = String(data["type"] ?? msg.event ?? "");
        switch (type) {
          case "message_start": {
            const m = (data["message"] as JsonObject | undefined) ?? {};
            const u = (m["usage"] as JsonObject | undefined) ?? {};
            usage.inputTokens = Number(u["input_tokens"] ?? 0);
            if (u["cache_read_input_tokens"] !== undefined) usage.cacheReadTokens = Number(u["cache_read_input_tokens"]);
            if (u["cache_creation_input_tokens"] !== undefined) usage.cacheWriteTokens = Number(u["cache_creation_input_tokens"]);
            if (typeof m["id"] === "string") usage.providerRequestId = m["id"];
            break;
          }
          case "content_block_start": {
            const index = Number(data["index"]);
            const cb = (data["content_block"] as JsonObject | undefined) ?? {};
            const entry = { type: String(cb["type"] ?? "text"), text: typeof cb["text"] === "string" ? cb["text"] : "", json: "", thinking: typeof cb["thinking"] === "string" ? cb["thinking"] : "", signature: "", id: cb["id"] as string | undefined, name: cb["name"] as string | undefined, data: cb["data"] as string | undefined };
            blocks.set(index, entry);
            if (entry.type === "tool_use") yield { type: "tool_call_start", index, alias: entry.name ?? "", providerCallId: entry.id };
            break;
          }
          case "content_block_delta": {
            const index = Number(data["index"]);
            const delta = (data["delta"] as JsonObject | undefined) ?? {};
            const entry = blocks.get(index) ?? { type: "text", text: "", json: "", thinking: "", signature: "" };
            blocks.set(index, entry);
            switch (delta["type"]) {
              case "text_delta": {
                const t = String(delta["text"] ?? "");
                entry.text += t;
                yield { type: "text_delta", text: t };
                break;
              }
              case "input_json_delta": {
                const pj = String(delta["partial_json"] ?? "");
                entry.json += pj;
                yield { type: "tool_call_delta", index, argumentsDelta: pj };
                break;
              }
              case "thinking_delta":
                entry.thinking += String(delta["thinking"] ?? "");
                break;
              case "signature_delta":
                entry.signature += String(delta["signature"] ?? "");
                break;
              default:
                break;
            }
            break;
          }
          case "message_delta": {
            const delta = (data["delta"] as JsonObject | undefined) ?? {};
            if (typeof delta["stop_reason"] === "string") {
              stopReason = STOP_MAP[delta["stop_reason"]] ?? "end_turn";
              sawStop = true;
            }
            if (typeof delta["stop_sequence"] === "string") stopSequence = delta["stop_sequence"];
            const u = (data["usage"] as JsonObject | undefined) ?? {};
            if (u["output_tokens"] !== undefined) usage.outputTokens = Number(u["output_tokens"]);
            if (u["input_tokens"] !== undefined) usage.inputTokens = Number(u["input_tokens"]);
            break;
          }
          case "error": {
            const e = (data["error"] as JsonObject | undefined) ?? {};
            const etype = String(e["type"] ?? "api_error");
            yield { type: "error", error: { code: etype === "overloaded_error" ? "PROVIDER_UNAVAILABLE" : "PROVIDER_STREAM_ERROR", message: String(e["message"] ?? etype), retryable: etype === "overloaded_error" || etype === "api_error" } };
            return;
          }
          case "message_stop":
          case "content_block_stop":
          case "ping":
          default:
            break;
        }
      }
    } catch (err) {
      if (err instanceof SSEByteLimitError) {
        yield { type: "error", error: { code: "PROVIDER_STREAM_ERROR", message: err.message, retryable: false } };
        return;
      }
      yield { type: "error", error: networkError(err, opts.signal.aborted) };
      return;
    }
    if (!sawStop && blocks.size === 0) {
      yield { type: "error", error: { code: "PROVIDER_STREAM_ERROR", message: "stream ended without a terminal message", retryable: true } };
      return;
    }
    const parts: NeutralPart[] = [];
    for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
      const b = blocks.get(index)!;
      if (b.type === "text") {
        if (b.text.length) parts.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        let args: JsonObject = {};
        if (b.json.trim().length) {
          try {
            const parsed = JSON.parse(b.json) as JsonValue;
            args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : { _invalid: b.json };
          } catch {
            args = { _invalid: b.json };
          }
        }
        parts.push({ type: "tool_call", callId: "", toolRef: "", alias: b.name ?? "", arguments: args, providerCallId: b.id });
      } else if (b.type === "thinking") {
        parts.push({ type: "opaque", provider: "anthropic", block: { type: "thinking", thinking: b.thinking, signature: b.signature } });
      } else if (b.type === "redacted_thinking") {
        parts.push({ type: "opaque", provider: "anthropic", block: { type: "redacted_thinking", data: b.data ?? "" } });
      }
    }
    if (!usage.reported || usage.outputTokens === 0) {
      const text = parts.map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? JSON.stringify(p.arguments) : "")).join("");
      if (usage.outputTokens === 0 && text.length > 0) {
        usage.outputTokens = estimateTokens(text);
        usage.reported = false;
      }
    }
    const done: ModelStreamEvent = { type: "done", message: { role: "assistant", parts }, stopReason, usage };
    if (stopSequence !== undefined) done.stopSequence = stopSequence;
    yield done;
  }
}

async function resolveKey(opts: { secrets: SecretResolver; binding: ModelBinding }): Promise<string> {
  if (!opts.binding.credential) throw new Error("model binding has no credential");
  return opts.secrets.resolve(opts.binding.credential);
}

/** Neutral transcript → Anthropic messages. Consecutive same-role messages are legal; the API combines them. */
export function compileMessages(messages: NeutralMessage[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const m of messages) {
    if (m.role === "tool_results") {
      out.push({
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.providerCallId ?? r.callId, content: toolResultText(r.content), is_error: r.isError })),
      });
      continue;
    }
    const content: JsonValue[] = [];
    for (const p of m.parts) {
      if (p.type === "text") {
        if (p.text.length) content.push({ type: "text", text: p.text });
      } else if (p.type === "tool_call") content.push({ type: "tool_use", id: p.providerCallId ?? p.callId, name: p.alias, input: p.arguments });
      else if (p.type === "opaque" && p.provider === "anthropic") content.push(p.block);
      else if (p.type === "media") content.push({ type: "text", text: p.text ?? `[media ${p.mediaType} unavailable]` });
    }
    if (content.length === 0) content.push({ type: "text", text: m.role === "assistant" ? "(no content)" : "" });
    out.push({ role: m.role, content });
  }
  return out;
}

export { estimateRequestTokens };
