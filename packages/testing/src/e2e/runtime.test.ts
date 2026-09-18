import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, SFieldError, ToolError } from "@sfield/core";
import type { JsonObject } from "@sfield/core";
import { baseConfig, createHarness, collectEvents, autoApprovalTransport, RecordingApprovalTransport, TEST_ACTOR, autoInputTransport } from "../harness.js";
import { FakeProvider } from "../fake-provider.js";

const orders = new Map([["A-1001", { id: "A-1001", status: "shipped", total_minor: 4599, currency: "INR" }]]);

function ordersGet() {
  return defineTool({
    id: "orders.get",
    version: "1.0.0",
    description: "Get an order by its ID.",
    inputs: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } },
    outputs: { type: "object", additionalProperties: false, required: ["id", "status", "total_minor", "currency"], properties: { id: { type: "string" }, status: { type: "string" }, total_minor: { type: "integer" }, currency: { type: "string" } } },
    authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } },
    async handler({ order_id }) {
      const order = orders.get(String(order_id));
      if (!order) throw new ToolError("NOT_FOUND", `order ${String(order_id)} not found`, { effect: "none" });
      return order;
    },
  });
}

function refundsRequest(calls: JsonObject[] = []) {
  return defineTool({
    id: "refunds.request",
    version: "1.0.0",
    description: "Request a refund for an order.",
    inputs: { type: "object", additionalProperties: false, required: ["order_id", "amount_minor", "currency"], properties: { order_id: { type: "string" }, amount_minor: { type: "integer", minimum: 1 }, currency: { type: "string", enum: ["INR", "USD"] } } },
    outputs: { type: "object", additionalProperties: false, required: ["refund_id", "status"], properties: { refund_id: { type: "string" }, status: { type: "string", enum: ["pending", "completed"] } } },
    resource: { type: "order", id: { ref: "inputs.order_id" } },
    policy: { effect: "destructive", action: "refund.request", retrySafety: "never" },
    async handler(inputs) {
      calls.push(inputs);
      return { refund_id: `rf_${calls.length}`, status: "pending" };
    },
  });
}

const agentConfig = (extra: JsonObject = {}) => baseConfig({
  agents: {
    support: {
      instructions: "Help with orders. Use tools when needed.",
      tools: ["orders.get"],
      memory: { conversation: true, preferences: "explicit" },
      ...extra,
    },
  },
});

test("read tool round trip: model calls a tool, gets the result, answers", async () => {
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    script: [
      { toolCalls: [{ alias: "orders_get", arguments: { order_id: "A-1001" } }] },
      { text: "Order A-1001 has shipped." },
    ],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "Where is order A-1001?" } });
  const events = collectEvents(run);
  const result = await run.result();
  assert.equal(result.state, "completed");
  assert.equal(result.output, "Order A-1001 has shipped.");
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.turns, 2);
  assert.ok(result.usage.inputTokens > 0);
  const types = (await events).map((e) => e.type);
  for (const t of ["run_accepted", "run_started", "context_built", "tool_prepared", "tool_started", "tool_finished", "run_finished"]) assert.ok(types.includes(t), `missing event ${t}: ${types.join(",")}`);
  // The second model request carried the tool result batch paired with the call.
  const second = h.provider.requests[1]!;
  const results = second.messages.find((m) => m.role === "tool_results");
  assert.ok(results && results.role === "tool_results");
  assert.deepEqual(results.results[0]!.content, { id: "A-1001", status: "shipped", total_minor: 4599, currency: "INR" });
  // Conversation history persisted: user, assistant(call), tool_results, assistant(answer).
  const history = await h.sf.conversations.history({ id: session.conversationId });
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "tool_results", "assistant"]);
  // Audit has the prepared invocation and the result.
  const audit = await h.sf.audit.read({ runId: run.id });
  assert.ok(audit.some((a) => a.type === "tool_prepared"));
  assert.ok(audit.some((a) => a.type === "tool_result"));
  await h.sf.close();
});

test("invalid tool arguments and unknown tools become error results without execution", async () => {
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    script: [
      { toolCalls: [{ alias: "orders_get", arguments: { order: "A-1001" } }, { alias: "nope", arguments: {} }] },
      { text: "done" },
    ],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "hi" } })).result();
  assert.equal(result.state, "completed");
  const second = h.provider.requests[1]!;
  const batch = second.messages.find((m) => m.role === "tool_results");
  assert.ok(batch && batch.role === "tool_results");
  assert.equal(batch.results.length, 2);
  assert.equal((batch.results[0]!.content as JsonObject)["error"] && ((batch.results[0]!.content as JsonObject)["error"] as JsonObject)["code"], "INVALID_INPUT");
  assert.equal(((batch.results[1]!.content as JsonObject)["error"] as JsonObject)["code"], "UNKNOWN_TOOL");
  await h.sf.close();
});

test("supervised mutation suspends for approval; interactive approval completes in one execution", async () => {
  const calls: JsonObject[] = [];
  const transport = autoApprovalTransport("approve");
  const h = await createHarness({
    config: agentConfig({ tools: ["orders.get", "refunds.request"] }),
    tools: [ordersGet(), refundsRequest(calls)],
    approvals: transport,
    script: [
      { toolCalls: [{ alias: "refunds_request", arguments: { order_id: "A-1001", amount_minor: 4599, currency: "INR" } }] },
      { text: "Refund requested (rf_1)." },
    ],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "refund A-1001" } });
  const events = collectEvents(run);
  const result = await run.result();
  assert.equal(result.state, "completed");
  assert.equal(transport.count, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]!.outcome, "confirmed");
  const types = (await events).map((e) => e.type);
  assert.ok(types.includes("approval_requested"));
  assert.ok(types.includes("approval_resolved"));
  const approvals = await h.sf.approvals.list({ runId: run.id });
  assert.equal(approvals[0]!.status, "consumed");
  assert.equal(approvals[0]!.view[0]!.amount?.value, 4599);
  await h.sf.close();
});

test("non-interactive approval parks the run durably, then decide() resumes it", async () => {
  const calls: JsonObject[] = [];
  const transport = new RecordingApprovalTransport();
  const h = await createHarness({
    config: agentConfig({ tools: ["refunds.request"] }),
    tools: [refundsRequest(calls)],
    approvals: transport,
    script: [
      { toolCalls: [{ alias: "refunds_request", arguments: { order_id: "A-1001", amount_minor: 100, currency: "INR" } }] },
      { text: "Refund requested." },
    ],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "refund" } });
  const suspended = await run.result();
  assert.equal(suspended.state, "waiting_approval");
  assert.equal(suspended.pending?.approvals.length, 1);
  assert.equal(calls.length, 0, "nothing dispatched before approval");
  // A second send on the same conversation is refused while the run is active.
  await assert.rejects(session.send({ message: { text: "again" } }), (e: unknown) => SFieldError.is(e, "CONVERSATION_BUSY"));
  const approvalId = suspended.pending!.approvals[0]!;
  await h.sf.approvals.decide({ approvalId, actor: TEST_ACTOR, decision: "approve" });
  // Idempotent repeat, then conflicting decision.
  await h.sf.approvals.decide({ approvalId, actor: TEST_ACTOR, decision: "approve" });
  await assert.rejects(h.sf.approvals.decide({ approvalId, actor: TEST_ACTOR, decision: "deny" }), (e: unknown) => SFieldError.is(e, "APPROVAL_ALREADY_DECIDED"));
  // The wake-up resumes the run in-process; wait for it.
  const resumed = await h.sf.runs.resume({ runId: run.id });
  const final = await resumed.result();
  assert.equal(final.state, "completed");
  assert.equal(calls.length, 1);
  await h.sf.close();
});

test("a denied mutation ends the run as denied and never executes", async () => {
  const calls: JsonObject[] = [];
  const h = await createHarness({
    config: agentConfig({ tools: ["refunds.request"] }),
    tools: [refundsRequest(calls)],
    approvals: autoApprovalTransport("deny"),
    script: [{ toolCalls: [{ alias: "refunds_request", arguments: { order_id: "A-1", amount_minor: 100, currency: "INR" } }] }, { text: "unreachable" }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "refund" } })).result();
  assert.equal(result.state, "denied");
  assert.equal(result.error?.code, "APPROVAL_DENIED");
  assert.equal(calls.length, 0);
  await h.sf.close();
});

test("read_only preset rejects a write tool at compile time", async () => {
  await assert.rejects(
    createHarness({ config: agentConfig({ tools: ["refunds.request"], policy: { preset: "read_only" } }), tools: [refundsRequest()] }),
    (e: unknown) => SFieldError.is(e, "EFFECT_NOT_ALLOWED"),
  );
});

test("repeated identical call: warned once, LOOP_DETECTED on the second repeat", async () => {
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    script: [
      { toolCalls: [{ alias: "orders_get", arguments: { order_id: "A-1001" } }] },
      { toolCalls: [{ alias: "orders_get", arguments: { order_id: "A-1001" } }] },
      { toolCalls: [{ alias: "orders_get", arguments: { order_id: "A-1001" } }] },
      { text: "unreachable" },
    ],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "loop" } })).result();
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "LOOP_DETECTED");
  const third = h.provider.requests[2]!;
  const batch = third.messages.filter((m) => m.role === "tool_results").pop();
  assert.ok(batch && batch.role === "tool_results");
  assert.equal(((batch.results[0]!.content as JsonObject)["error"] as JsonObject)["code"], "REPEATED_CALL");
  const audit = await h.sf.audit.read({ type: "loop_detected" });
  assert.equal(audit.length, 1);
  await h.sf.close();
});

test("request idempotency: same key+payload returns the original run; different payload conflicts", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()], script: [{ text: "hello" }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  const a = await session.send({ message: { text: "hi" }, idempotencyKey: "k1" });
  await a.result();
  const b = await session.send({ message: { text: "hi" }, idempotencyKey: "k1" });
  assert.equal(b.id, a.id);
  await assert.rejects(session.send({ message: { text: "different" }, idempotencyKey: "k1" }), (e: unknown) => SFieldError.is(e, "IDEMPOTENCY_CONFLICT"));
  const generated = await session.send({ message: { text: "hi" } });
  assert.ok(generated.idempotencyKey.startsWith("req_"));
  await h.sf.close();
});

test("structured output: invalid JSON triggers one repair, then completes with parsed output", async () => {
  const h = await createHarness({
    config: agentConfig({ output: { schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }, max_repairs: 1 } }),
    tools: [ordersGet()],
    script: [{ text: "not json" }, { text: '{"answer":"42"}' }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "q" } });
  const result = await run.result();
  assert.equal(result.state, "completed");
  assert.deepEqual(result.output, { answer: "42" });
  assert.equal(h.provider.requests.length, 2);
  await h.sf.close();
});

test("verification_failed when repairs are exhausted", async () => {
  const h = await createHarness({
    config: agentConfig({ output: { schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }, max_repairs: 1 } }),
    tools: [ordersGet()],
    script: [{ text: "nope" }, { text: "still nope" }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "q" } })).result();
  assert.equal(result.state, "verification_failed");
  await h.sf.close();
});

test("budget: max_turns exhausts the run", async () => {
  const h = await createHarness({
    config: agentConfig({ budget: { max_turns: 2 } }),
    tools: [ordersGet()],
    script: (_req, i) => ({ toolCalls: [{ alias: "orders_get", arguments: { order_id: `A-${i}` } }] }),
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "spin" } })).result();
  assert.equal(result.state, "budget_exhausted");
  assert.equal(result.usage.turns, 2);
  await h.sf.close();
});

test("provider errors: retryable failure then success is metered as two attempts", async () => {
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    script: [{ error: { code: "PROVIDER_UNAVAILABLE", message: "503", retryable: true, retryAfterMs: 10 } }, { text: "recovered" }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "q" } })).result();
  assert.equal(result.state, "completed");
  assert.equal(result.usage.providerAttempts, 2);
  assert.equal(result.usage.modelCalls, 1);
  await h.sf.close();
});

test("refusal and content filter map to their terminal states", async () => {
  for (const [stop, state] of [["refusal", "refused"], ["content_filter", "filtered"]] as const) {
    const h = await createHarness({ config: agentConfig(), tools: [ordersGet()], script: [{ text: "no", stopReason: stop }] });
    const session = await h.sf.sessions.open({ agent: "support" });
    const result = await (await session.send({ message: { text: "q" } })).result();
    assert.equal(result.state, state);
    await h.sf.close();
  }
});

test("cancellation aborts a slow model call and records cancelled", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()], script: [{ text: "slow", delayMs: 2000 }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "q" } });
  await new Promise((r) => setTimeout(r, 50));
  await run.cancel("user left");
  const result = await run.result();
  assert.equal(result.state, "cancelled");
  await h.sf.close();
});

test("ask_user suspends for input; the authenticated answer becomes the tool result", async () => {
  const input = autoInputTransport("blue");
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    input,
    script: [{ toolCalls: [{ alias: "ask_user", arguments: { question: "Which colour?" } }] }, { text: "Blue it is." }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "pick" } });
  const events = collectEvents(run);
  const result = await run.result();
  assert.equal(result.state, "completed");
  assert.equal(input.count, 1);
  const batch = h.provider.requests[1]!.messages.find((m) => m.role === "tool_results");
  assert.ok(batch && batch.role === "tool_results");
  assert.deepEqual(batch.results[0]!.content, { status: "answered", value: "blue" });
  const types = (await events).map((e) => e.type);
  assert.ok(types.includes("input_requested") && types.includes("input_resolved"));
  await h.sf.close();
});

test("memory.remember requires confirmation, then the preference shows up in later context", async () => {
  const input = autoInputTransport(true);
  const h = await createHarness({
    config: agentConfig(),
    tools: [ordersGet()],
    input,
    script: [{ toolCalls: [{ alias: "memory_remember", arguments: { content: "Reply in Hindi", key: "language" } }] }, { text: "Noted." }, { text: "ठीक है" }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const first = await (await session.send({ message: { text: "remember to reply in Hindi" } })).result();
  assert.equal(first.state, "completed");
  const batch = h.provider.requests[1]!.messages.find((m) => m.role === "tool_results");
  assert.ok(batch && batch.role === "tool_results");
  assert.equal((batch.results[0]!.content as JsonObject)["status"], "saved");
  const items = await h.sf.memory.for().list({ kind: "preference" });
  assert.equal(items.items.length, 1);
  assert.equal(items.items[0]!.origin, "user_confirmed");
  assert.equal(items.items[0]!.structured?.key, "language");
  const second = await (await session.send({ message: { text: "hello" } })).result();
  assert.equal(second.state, "completed");
  const req = h.provider.requests[2]!;
  const userMsg = req.messages[req.messages.length - 1]!;
  assert.ok(userMsg.role === "user" && userMsg.parts.some((p) => p.type === "text" && p.text.includes("Reply in Hindi")));
  await h.sf.close();
});

test("provisional text deltas stream and are withheld when a secret spans chunks", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()], script: [{ deltas: ["The key is fake-secret-", "value-123456 ok"], text: "The key is fake-secret-value-123456 ok" }] });
  // Resolve the secret so the scrubber knows its value (the harness sets FAKE_KEY; resolve it once).
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "q" } });
  const texts: string[] = [];
  for await (const ev of run.events()) if (ev.type === "text_delta") texts.push(String(ev.payload["text"]));
  const streamed = texts.join("");
  assert.ok(!streamed.includes("fake-secret-value-123456"), `secret leaked in stream: ${streamed}`);
  await run.result();
  await h.sf.close();
});

test("external loop: execution scope executes registered tools through the same pipeline", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()] });
  const scope = await h.sf.executions.open({ purpose: "batch-check" });
  const res = await scope.registry.execute("orders.get", { order_id: "A-1001" });
  assert.equal(res.status, "succeeded");
  assert.equal((res.output as JsonObject)["status"], "shipped");
  const missing = await scope.registry.execute("orders.get", { order_id: "nope" });
  assert.equal(missing.status, "failed");
  assert.equal(missing.error?.code, "NOT_FOUND");
  assert.equal(missing.effect, "none");
  await scope.modelCall({ inputTokens: 10, outputTokens: 5 });
  const result = await scope.close();
  assert.equal(result.state, "completed");
  assert.equal(result.usage.toolCalls, 2);
  assert.equal(result.usage.modelCalls, 1);
  await h.sf.close();
});

test("sf.context.build assembles instructions, preferences, and the current message for an external loop", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()] });
  await h.sf.memory.for().put({ scope: { kind: "subject", tenantId: "t1", subjectId: "u1" }, kind: "preference", content: "Prefers email", origin: "user_explicit", provenance: [{ sourceType: "host", sourceId: "import", observedAt: new Date().toISOString() }] }, { idempotencyKey: "p1" });
  const out = await h.sf.context.build({ agent: "support", message: { text: "hi" } });
  assert.ok(out.packet.blocks.some((b) => b.kind === "preference"));
  assert.ok(out.packet.blocks.some((b) => b.kind === "instruction" && b.required));
  assert.equal(out.request.tools.length, 3); // orders.get + memory.remember + memory.forget (no input transport → no ask_user)
  const explained = await h.sf.context.explain({ contextId: out.packet.id });
  assert.equal(explained.included.length, out.packet.blocks.length);
  await h.sf.close();
});

test("registerTool after the first run is rejected", async () => {
  const h = await createHarness({ config: agentConfig(), tools: [ordersGet()], script: [{ text: "x" }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  await (await session.send({ message: { text: "q" } })).result();
  assert.throws(() => h.sf.registerTool({ id: "late.tool", version: "1.0.0", description: "late", inputs: { type: "object", additionalProperties: false, properties: {} }, outputs: { type: "object", additionalProperties: false, properties: {} }, handler: async () => ({}) }), (e: unknown) => SFieldError.is(e, "REGISTRATION_CLOSED"));
  await h.sf.close();
});

test("fallback model is used after the primary fails non-retryably", async () => {
  const primary = new FakeProvider([{ error: { code: "PROVIDER_REQUEST_REJECTED", message: "400", retryable: false } }, { text: "from fallback" }]);
  const h = await createHarness({
    config: baseConfig({
      models: { default: { provider: "fake", model: "a", credential: { env: "FAKE_KEY" }, fallback: "backup" }, backup: { provider: "fake", model: "b", credential: { env: "FAKE_KEY" } } },
      agents: { support: { instructions: "x", tools: [] } },
    }),
    provider: primary,
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "q" } });
  const events = collectEvents(run);
  const result = await run.result();
  assert.equal(result.state, "completed");
  assert.equal(result.output, "from fallback");
  assert.ok((await events).some((e) => e.type === "model_fallback"));
  assert.equal(primary.requests[1]!.binding.model, "b");
  await h.sf.close();
});
