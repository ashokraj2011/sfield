/** OpenAI-compatible chat-completions adapter over fetch + SSE (§13.6), with a documented quirks set. */
import type { JsonObject, JsonValue } from "../../types/common.js";
import type { SecretResolver } from "../../types/options.js";
import type { CompiledModelRequest, ModelBinding, ModelCapabilities, ModelProvider, ModelStreamEvent, NeutralMessage, NeutralModelRequest, NeutralPart, OpenAIQuirk, StopReason, Usage } from "../../types/model.js";
import { parseSSE, SSEByteLimitError } from "../../util/sse.js";
import { estimateTokens } from "../../util/tokens.js";
import { MAX_PROVIDER_STREAM_BYTES, bodyDigest, classifyHttpError, networkError, parseRetryAfter, readErrorBody, safeJson, schemaIsStrictCompatible, sortedTools, stableBody, toolResultText } from "./shared.js";

const FINISH_MAP: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "content_filter",
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai_compatible";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async describe(binding: ModelBinding): Promise<ModelCapabilities> {
    const quirks = new Set<OpenAIQuirk>(binding.quirks ?? []);
    return {
      inputLimit: binding.limits.contextWindow,
      outputLimit: binding.limits.maxOutputTokens,
      toolUse: true,
      structuredOutput: quirks.has("json_mode_only") ? "json_mode" : "json_schema",
      strictTools: !quirks.has("no_strict"),
      streamingUsage: !quirks.has("no_stream_usage"),
      media: [],
      opaqueContinuation: false,
      tokenCounting: "estimated",
      continueStopReason: false,
    };
  }

  async compile(request: NeutralModelRequest): Promise<CompiledModelRequest> {
    const binding = request.binding;
    const quirks = new Set<OpenAIQuirk>(binding.quirks ?? []);
    const degradations: string[] = [];
    const notes: string[] = [];
    const tools = sortedTools(request.tools);
    const aliasMap: Record<string, string> = {};
    const wireTools: JsonValue[] = [];
    for (const t of tools) {
      aliasMap[t.alias] = t.ref;
      const fn: JsonObject = { name: t.alias, description: t.description, parameters: t.inputSchema as JsonObject };
      const strict = !quirks.has("no_strict") && schemaIsStrictCompatible(t.inputSchema);
      if (strict) fn["strict"] = true;
      else if (!quirks.has("no_strict")) notes.push(`${t.ref}: optional properties; strict not requested, local validation applies`);
      wireTools.push({ type: "function", function: fn });
    }
    const messages: JsonValue[] = [];
    const systemText = request.instructions.join("\n\n");
    let foldSystem = quirks.has("system_as_user");
    if (!foldSystem && systemText.length) messages.push({ role: "system", content: systemText });
    for (const m of request.messages) {
      if (m.role === "tool_results") {
        for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.providerCallId ?? r.callId, content: toolResultText(r.content) });
        continue;
      }
      if (m.role === "user") {
        let text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "media" ? (p.text ?? `[media ${p.mediaType} unavailable]`) : "")).join("\n");
        if (foldSystem) {
          text = `${systemText}\n\n${text}`;
          foldSystem = false;
          degradations.push("system_as_user");
        }
        messages.push({ role: "user", content: text });
        continue;
      }
      const text = m.parts.filter((p): p is Extract<NeutralPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
      const calls = m.parts.filter((p): p is Extract<NeutralPart, { type: "tool_call" }> => p.type === "tool_call");
      const msg: JsonObject = { role: "assistant", content: text.length ? text : null };
      if (calls.length) msg["tool_calls"] = calls.map((c) => ({ id: c.providerCallId ?? c.callId, type: "function", function: { name: c.alias, arguments: JSON.stringify(c.arguments) } }));
      const opaque = m.parts.filter((p): p is Extract<NeutralPart, { type: "opaque" }> => p.type === "opaque" && p.provider === "openai_compatible");
      for (const o of opaque) for (const [k, v] of Object.entries(o.block)) msg[k] = v;
      messages.push(msg);
    }
    const body: JsonObject = { model: binding.model, messages, stream: true };
    if (!quirks.has("no_stream_usage")) body["stream_options"] = { include_usage: true };
    else degradations.push("no_stream_usage: usage estimated");
    if (wireTools.length) {
      body["tools"] = wireTools;
      if (!quirks.has("tool_choice_unsupported")) body["tool_choice"] = request.toolChoice === "none" ? "none" : "auto";
      else if (request.toolChoice === "none") degradations.push("tool_choice_unsupported: tools omitted");
      if (quirks.has("tool_choice_unsupported") && request.toolChoice === "none") delete body["tools"];
    }
    body["max_tokens"] = request.params.maxOutputTokens;
    if (request.params.temperature !== undefined) body["temperature"] = request.params.temperature;
    if (request.params.topP !== undefined) body["top_p"] = request.params.topP;
    if (request.params.stopSequences?.length) body["stop"] = request.params.stopSequences;
    for (const k of ["seed", "presence_penalty", "frequency_penalty"]) if (typeof binding.params?.[k] === "number") body[k] = binding.params[k]!;
    let schemaExact = true;
    if (request.outputSchema) {
      if (quirks.has("json_mode_only")) {
        body["response_format"] = { type: "json_object" };
        degradations.push("json_mode_only: schema enforced locally only");
        schemaExact = false;
        // The schema must still be visible to the model somewhere stable: append to the system/first message.
        const first = messages[0] as JsonObject;
        if (first && first["role"] === "system") first["content"] = `${String(first["content"])}\n\nRespond with JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`;
      } else {
        body["response_format"] = { type: "json_schema", json_schema: { name: "output", schema: request.outputSchema as JsonObject, strict: schemaIsStrictCompatible(request.outputSchema) } };
      }
    }
    const serialized = stableBody(body);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(binding.headers ?? {}) };
    return {
      provider: this.id,
      url: `${(binding.baseUrl ?? "").replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers,
      body: serialized,
      aliasMap,
      overheadTokens: tools.reduce((n, t) => n + t.tokens, 0),
      degradations,
      equivalence: { toolsExact: true, schemaExact, notes },
      digest: bodyDigest(serialized),
    };
  }

  async *stream(request: CompiledModelRequest, opts: { signal: AbortSignal; attemptId: string; secrets: SecretResolver; binding: ModelBinding }): AsyncIterable<ModelStreamEvent> {
    const headers: Record<string, string> = { ...request.headers };
    if (opts.binding.credential) headers["authorization"] = `Bearer ${await opts.secrets.resolve(opts.binding.credential)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(request.url, { method: "POST", headers, body: request.body, signal: opts.signal });
    } catch (err) {
      yield { type: "error", error: networkError(err, opts.signal.aborted) };
      return;
    }
    if (!res.ok) {
      const text = await readErrorBody(res);
      const json = safeJson(text);
      const errObj = json && typeof json["error"] === "object" && json["error"] ? (json["error"] as JsonObject) : null;
      const message = (errObj?.["message"] as string | undefined) ?? (typeof json?.["error"] === "string" ? (json["error"] as string) : undefined);
      yield { type: "error", error: classifyHttpError({ status: res.status, body: text, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) }, message, errObj?.["type"] as string | undefined) };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: { code: "PROVIDER_UNAVAILABLE", message: "empty response body", retryable: true } };
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    let text = "";
    const toolCalls = new Map<number, { id?: string; name: string; args: string }>();
    let finish: StopReason | undefined;
    let usage: Usage | undefined;
    let requestId: string | undefined;
    const quirks = new Set<OpenAIQuirk>(opts.binding.quirks ?? []);
    const apply = (chunk: JsonObject): void => {
      if (typeof chunk["id"] === "string") requestId = chunk["id"];
      const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as JsonObject[]) : [];
      for (const ch of choices) {
        const delta = ((ch["delta"] ?? ch["message"]) as JsonObject | undefined) ?? {};
        if (typeof delta["content"] === "string" && delta["content"].length) text += delta["content"];
        if (Array.isArray(delta["tool_calls"])) {
          for (const tc of delta["tool_calls"] as JsonObject[]) {
            const index = Number(tc["index"] ?? toolCalls.size);
            const entry = toolCalls.get(index) ?? { name: "", args: "" };
            if (typeof tc["id"] === "string") entry.id = tc["id"];
            const fn = (tc["function"] as JsonObject | undefined) ?? {};
            if (typeof fn["name"] === "string") entry.name += fn["name"];
            if (typeof fn["arguments"] === "string") entry.args += fn["arguments"];
            toolCalls.set(index, entry);
          }
        }
        if (typeof ch["finish_reason"] === "string" && ch["finish_reason"]) finish = FINISH_MAP[ch["finish_reason"]] ?? "end_turn";
      }
      const u = chunk["usage"] as JsonObject | null | undefined;
      if (u && typeof u === "object") {
        usage = { inputTokens: Number(u["prompt_tokens"] ?? 0), outputTokens: Number(u["completion_tokens"] ?? 0), reported: true };
        const details = u["prompt_tokens_details"] as JsonObject | undefined;
        if (details && typeof details["cached_tokens"] === "number") usage.cacheReadTokens = details["cached_tokens"];
        const cdetails = u["completion_tokens_details"] as JsonObject | undefined;
        if (cdetails && typeof cdetails["reasoning_tokens"] === "number") usage.reasoningTokens = cdetails["reasoning_tokens"];
      }
    };
    try {
      if (contentType.includes("application/json")) {
        // Non-streaming server: one JSON completion object.
        const json = safeJson(await res.text());
        if (!json) throw new Error("invalid JSON completion");
        apply(json);
      } else {
        for await (const msg of parseSSE(res.body, { maxBytes: MAX_PROVIDER_STREAM_BYTES, signal: opts.signal })) {
          if (!msg.data || msg.data.trim() === "[DONE]") continue;
          const chunk = safeJson(msg.data);
          if (!chunk) continue;
          if (chunk["error"]) {
            const e = chunk["error"] as JsonObject | string;
            const message = typeof e === "string" ? e : String((e as JsonObject)["message"] ?? "stream error");
            yield { type: "error", error: { code: "PROVIDER_STREAM_ERROR", message, retryable: false } };
            return;
          }
          const before = text.length;
          apply(chunk);
          if (text.length > before) yield { type: "text_delta", text: text.slice(before) };
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
    if (finish === undefined && text.length === 0 && toolCalls.size === 0) {
      yield { type: "error", error: { code: "PROVIDER_STREAM_ERROR", message: "stream ended without a completion", retryable: true } };
      return;
    }
    const parts: NeutralPart[] = [];
    if (text.length) parts.push({ type: "text", text });
    for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
      const tc = toolCalls.get(index)!;
      let args: JsonObject = {};
      if (tc.args.trim().length) {
        try {
          const parsed = JSON.parse(tc.args) as JsonValue;
          args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : { _invalid: tc.args };
        } catch {
          args = { _invalid: tc.args };
        }
      }
      parts.push({ type: "tool_call", callId: "", toolRef: "", alias: tc.name, arguments: args, providerCallId: tc.id });
    }
    let stopReason: StopReason = finish ?? (toolCalls.size ? "tool_use" : "end_turn");
    if (stopReason === "end_turn" && toolCalls.size > 0) stopReason = "tool_use";
    if (!usage) {
      const inputEstimate = estimateTokens(request.body);
      usage = { inputTokens: inputEstimate, outputTokens: estimateTokens(text + [...toolCalls.values()].map((t) => t.args).join("")), reported: false };
      if (!quirks.has("no_stream_usage")) void 0; // usage simply absent from this server; labeled estimated
    }
    if (requestId) usage.providerRequestId = requestId;
    yield { type: "done", message: { role: "assistant", parts }, stopReason, usage };
  }
}

export function compileNeutralForTest(messages: NeutralMessage[]): JsonValue[] {
  return messages.map((m) => (m.role === "tool_results" ? { role: "tool_results", n: m.results.length } : { role: m.role, n: m.parts.length }));
}
