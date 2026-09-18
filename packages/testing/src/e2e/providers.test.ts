import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, OpenAICompatibleProvider, ModelGateway, EnvSecretResolver, SFieldError } from "@sfield/core";
import type { ModelBinding, NeutralModelRequest, ModelStreamEvent, JsonObject } from "@sfield/core";
import { fakeFetch, sseBody } from "../sse-fixtures.js";
import { providerSerializationConformance } from "../conformance.js";

const secrets = new EnvSecretResolver({ KEY: "test-key-value-000" });

function binding(provider: string, extra: Partial<ModelBinding> = {}): ModelBinding {
  return {
    identity: { id: `model:${provider}`, revision: "1", accountScope: "acct", classification: "restricted" },
    provider,
    model: provider === "anthropic" ? "claude-x" : "qwen",
    baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434/v1",
    credential: { env: "KEY" },
    acceptsClassification: "restricted",
    limits: { contextWindow: 100000, maxOutputTokens: 1024 },
    prices: { version: "2026-01", inputPerMTok: 3_000_000, outputPerMTok: 15_000_000 },
    supportedParams: [],
    ...extra,
  };
}

function request(provider: string, extra: Partial<NeutralModelRequest> = {}): NeutralModelRequest {
  return {
    binding: binding(provider),
    instructions: ["Be helpful."],
    messages: [{ role: "user", parts: [{ type: "text", text: "Where is order A-1?" }] }],
    tools: [
      { ref: "orders.get@1.0.0", alias: "orders_get", description: "Get an order", inputSchema: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } }, effect: "read", requiresApproval: false, tokens: 40, builtin: false },
      { ref: "ask_user@1.0.0", alias: "ask_user", description: "Ask", inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } } }, effect: "read", requiresApproval: false, tokens: 30, builtin: true },
    ],
    params: { maxOutputTokens: 500, temperature: 0 },
    toolChoice: "auto",
    ...extra,
  };
}

async function drain(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

test("anthropic: compile is byte-stable, sorts tools, marks the cache prefix, and requests strict only when compatible", async () => {
  const p = new AnthropicProvider(fakeFetch([]));
  for (const c of providerSerializationConformance(p, request("anthropic"))) await c.run();
  const compiled = await p.compile(request("anthropic"));
  const body = JSON.parse(compiled.body) as JsonObject;
  assert.equal(compiled.url, "https://api.anthropic.com/v1/messages");
  assert.equal(compiled.headers["anthropic-version"], "2023-06-01");
  assert.ok(!("x-api-key" in compiled.headers), "no secret in the compiled request");
  const tools = body["tools"] as JsonObject[];
  assert.deepEqual(tools.map((t) => t["name"]), ["ask_user", "orders_get"]);
  assert.equal(tools[1]!["strict"], true);
  assert.equal(tools[0]!["strict"], undefined, "optional property → no strict, local validation applies");
  assert.deepEqual((body["system"] as JsonObject[])[0]!["cache_control"], { type: "ephemeral" });
  assert.equal(body["stream"], true);
});

test("anthropic: streams text and parallel tool calls, round-trips usage and stop reasons", async () => {
  const events = sseBody([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 10 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "orders_get", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"order_' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'id":"A-1"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "orders_get", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"order_id":"A-2"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const fetchImpl = fakeFetch([{ sse: events, chunkSize: 7 }]);
  const p = new AnthropicProvider(fetchImpl);
  const compiled = await p.compile(request("anthropic"));
  const out = await drain(p.stream(compiled, { signal: new AbortController().signal, attemptId: "a1", secrets, binding: binding("anthropic") }));
  const deltas = out.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  assert.equal(deltas, "Let me check.");
  const done = out[out.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.stopReason, "tool_use");
  assert.deepEqual(done.usage, { inputTokens: 25, outputTokens: 42, reported: true, cacheReadTokens: 10, providerRequestId: "msg_1" });
  const calls = done.message.parts.filter((pt) => pt.type === "tool_call");
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[0] as { arguments: JsonObject }).arguments, { order_id: "A-1" });
  assert.equal((calls[1] as { providerCallId: string }).providerCallId, "toolu_2");
  assert.equal(fetchImpl.calls[0]!.init.headers && (fetchImpl.calls[0]!.init.headers as Record<string, string>)["x-api-key"], "test-key-value-000");
});

test("anthropic: opaque thinking blocks round-trip byte-faithfully into the next request", async () => {
  const events = sseBody([
    { event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 5 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
  ]);
  const p = new AnthropicProvider(fakeFetch([{ sse: events }]));
  const compiled = await p.compile(request("anthropic"));
  const out = await drain(p.stream(compiled, { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("anthropic") }));
  const done = out[out.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.deepEqual(done.message.parts[0], { type: "opaque", provider: "anthropic", block: { type: "thinking", thinking: "hmm", signature: "sig123" } });
  const next = await p.compile(request("anthropic", { messages: [...request("anthropic").messages, done.message, { role: "user", parts: [{ type: "text", text: "thanks" }] }] }));
  const body = JSON.parse(next.body) as JsonObject;
  const assistant = (body["messages"] as JsonObject[])[1]!;
  assert.deepEqual((assistant["content"] as JsonObject[])[0], { type: "thinking", thinking: "hmm", signature: "sig123" });
});

test("anthropic: HTTP errors are classified with retry disposition; 400 prompt-too-long maps to CONTEXT_EXCEEDED; in-stream error", async () => {
  const p429 = new AnthropicProvider(fakeFetch([{ status: 429, headers: { "retry-after": "2" }, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }) }]));
  let out = await drain(p429.stream(await p429.compile(request("anthropic")), { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("anthropic") }));
  assert.equal(out[0]!.type, "error");
  if (out[0]!.type === "error") {
    assert.equal(out[0]!.error.code, "PROVIDER_RATE_LIMITED");
    assert.equal(out[0]!.error.retryable, true);
    assert.equal(out[0]!.error.retryAfterMs, 2000);
  }
  const p400 = new AnthropicProvider(fakeFetch([{ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }) }]));
  out = await drain(p400.stream(await p400.compile(request("anthropic")), { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("anthropic") }));
  assert.equal(out[0]!.type === "error" && out[0]!.error.code, "CONTEXT_EXCEEDED");
  const pstream = new AnthropicProvider(fakeFetch([{ sse: sseBody([{ event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } }, { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]) }]));
  out = await drain(pstream.stream(await pstream.compile(request("anthropic")), { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("anthropic") }));
  assert.equal(out[0]!.type === "error" && out[0]!.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(out[0]!.type === "error" && out[0]!.error.retryable, true);
});

test("anthropic: max_tokens truncation and cancellation mid-stream", async () => {
  const events = sseBody([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 500 } } },
  ]);
  const p = new AnthropicProvider(fakeFetch([{ sse: events }]));
  const out = await drain(p.stream(await p.compile(request("anthropic")), { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("anthropic") }));
  const done = out[out.length - 1]!;
  assert.equal(done.type === "done" && done.stopReason, "max_tokens");
  const controller = new AbortController();
  const slow = new AnthropicProvider(fakeFetch([{ sse: events, chunkSize: 5 }]));
  const it = slow.stream(await slow.compile(request("anthropic")), { signal: controller.signal, attemptId: "a", secrets, binding: binding("anthropic") })[Symbol.asyncIterator]();
  await it.next();
  controller.abort();
  const rest: ModelStreamEvent[] = [];
  for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
  assert.ok(rest.some((e) => e.type === "error" && e.error.code === "CANCELLED"), "cancellation surfaces as a CANCELLED error");
});

test("openai_compatible: compile maps system/tools/response_format and streams chunked tool-call fragments with usage", async () => {
  const p = new OpenAICompatibleProvider(fakeFetch([]));
  for (const c of providerSerializationConformance(p, request("openai_compatible"))) await c.run();
  const compiled = await p.compile(request("openai_compatible", { outputSchema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } } }));
  const body = JSON.parse(compiled.body) as JsonObject;
  assert.equal(compiled.url, "http://localhost:11434/v1/chat/completions");
  assert.equal((body["messages"] as JsonObject[])[0]!["role"], "system");
  assert.deepEqual((body["tools"] as JsonObject[]).map((t) => (t["function"] as JsonObject)["name"]), ["ask_user", "orders_get"]);
  assert.deepEqual(body["stream_options"], { include_usage: true });
  assert.equal((body["response_format"] as JsonObject)["type"], "json_schema");
  const chunks = sseBody([
    { data: { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "Sure" }, finish_reason: null }] } },
    { data: { id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "orders_get", arguments: '{"order' } }] }, finish_reason: null }] } },
    { data: { id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '_id":"A-1"}' } }] }, finish_reason: null }] } },
    { data: { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
    { data: { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } } },
    { data: "[DONE]" },
  ]);
  const fetchImpl = fakeFetch([{ sse: chunks, chunkSize: 11 }]);
  const p2 = new OpenAICompatibleProvider(fetchImpl);
  const out = await drain(p2.stream(await p2.compile(request("openai_compatible")), { signal: new AbortController().signal, attemptId: "a", secrets, binding: binding("openai_compatible") }));
  const done = out[out.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.stopReason, "tool_use");
  assert.deepEqual(done.usage, { inputTokens: 50, outputTokens: 12, reported: true, providerRequestId: "chatcmpl-1" });
  const call = done.message.parts.find((pt) => pt.type === "tool_call") as { arguments: JsonObject; providerCallId: string };
  assert.deepEqual(call.arguments, { order_id: "A-1" });
  assert.equal(call.providerCallId, "call_1");
  assert.equal((fetchImpl.calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer test-key-value-000");
});

test("openai_compatible quirks: system_as_user folds instructions, no_stream_usage estimates, json_mode_only degrades", async () => {
  const b = binding("openai_compatible", { quirks: ["system_as_user", "no_stream_usage", "json_mode_only", "no_strict"] });
  const p = new OpenAICompatibleProvider(fakeFetch([{ sse: sseBody([{ data: { choices: [{ index: 0, delta: { content: '{"a":"b"}' }, finish_reason: "stop" }] } }, { data: "[DONE]" }]) }]));
  const compiled = await p.compile(request("openai_compatible", { binding: b, outputSchema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } } }));
  const body = JSON.parse(compiled.body) as JsonObject;
  assert.equal((body["messages"] as JsonObject[])[0]!["role"], "user");
  assert.ok(String((body["messages"] as JsonObject[])[0]!["content"]).startsWith("Be helpful."));
  assert.equal(body["stream_options"], undefined);
  assert.deepEqual(body["response_format"], { type: "json_object" });
  assert.ok(compiled.degradations.includes("system_as_user"));
  assert.equal(compiled.equivalence.schemaExact, false);
  const out = await drain(p.stream(compiled, { signal: new AbortController().signal, attemptId: "a", secrets, binding: b }));
  const done = out[out.length - 1]!;
  assert.equal(done.type === "done" && done.usage.reported, false, "usage is estimated and labeled");
});

test("gateway: retryable attempts are metered separately and a non-retryable error fails closed", async () => {
  const p = new AnthropicProvider(fakeFetch([
    { status: 503, body: JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }) },
    { sse: sseBody([{ event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5 } } } }, { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }, { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } }]) },
  ]));
  const gw = new ModelGateway({ providers: new Map([["anthropic", p]]), secrets, backoffMs: 1, maxBackoffMs: 2 });
  const attempts: string[] = [];
  let n = 0;
  const res = await gw.dispatch(request("anthropic"), { runId: "r", signal: new AbortController().signal, beginAttempt: async () => ({ attemptId: `a${++n}` }), onAttempt: async (rec) => { attempts.push(rec.status); } });
  assert.deepEqual(attempts, ["failed", "succeeded"]);
  assert.equal(res.costMicroUsd, Math.ceil((5 * 3_000_000) / 1e6) + Math.ceil((1 * 15_000_000) / 1e6));
  assert.equal(res.costLabel, "priced");
  const bad = new AnthropicProvider(fakeFetch([{ status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }) }]));
  const gw2 = new ModelGateway({ providers: new Map([["anthropic", bad]]), secrets });
  await assert.rejects(gw2.dispatch(request("anthropic"), { runId: "r", signal: new AbortController().signal, beginAttempt: async () => ({ attemptId: "x" }), onAttempt: async () => undefined }), (e: unknown) => SFieldError.is(e, "PROVIDER_UNAVAILABLE") && /PROVIDER_AUTH/.test((e as Error).message));
});
