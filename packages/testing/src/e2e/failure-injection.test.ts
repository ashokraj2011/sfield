import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, SFieldError, InMemoryMemoryIndex, InMemoryMemoryRepository, MemoryService, InMemoryArtifactStore, newId, nowIso } from "@sfield/core";
import type { JsonObject, Checkpoint, NeutralMessage } from "@sfield/core";
import { baseConfig, createHarness, RecordingApprovalTransport, TEST_ACTOR, TEST_PRINCIPAL } from "../harness.js";
import { FakeProvider } from "../fake-provider.js";

function refundsTool(calls: JsonObject[], reconcileBinding?: string) {
  return defineTool({
    id: "refunds.request",
    version: "1.0.0",
    description: "Request a refund.",
    inputs: { type: "object", additionalProperties: false, required: ["order_id", "amount_minor"], properties: { order_id: { type: "string" }, amount_minor: { type: "integer" } } },
    outputs: { type: "object", additionalProperties: false, required: ["refund_id", "status"], properties: { refund_id: { type: "string" }, status: { type: "string" } } },
    resource: { type: "order", id: { ref: "inputs.order_id" } },
    policy: { effect: "destructive", action: "refund.request", retrySafety: reconcileBinding ? "deduplicated" : "never", maxAttempts: reconcileBinding ? 2 : 1 },
    deduplication: reconcileBinding ? { keyLocation: { header: "Idempotency-Key" }, scope: "billing", retentionSeconds: 604800, payloadMismatch: "reject", reconcileBinding } : undefined,
    async handler(inputs) {
      calls.push(inputs);
      return { refund_id: "rf_live", status: "pending" };
    },
  });
}

const cfg = (extra: JsonObject = {}) => baseConfig({ agents: { support: { instructions: "Help.", tools: ["refunds.request"], memory: { conversation: true }, ...extra } } });

/** Simulates a crash after the dispatch intent was recorded but before any result (§16.4 row 3). */
async function crashedAfterIntent(h: Awaited<ReturnType<typeof createHarness>>, inputs: JsonObject): Promise<string> {
  const p = h.persistence;
  const def = h.sf.registry.describe("refunds.request");
  const runId = newId("run");
  const callId = newId("call");
  const digest = h.sf.config.digest();
  await p.acceptRequest({
    run: { runId, tenantId: TEST_PRINCIPAL.tenantId, subjectId: TEST_PRINCIPAL.subjectId, principal: TEST_PRINCIPAL, agentId: "support", kind: "standalone", scopeId: runId, state: "queued", request: { message: { text: "refund" } }, requestDigest: "sha256:x", idempotencyKey: runId, idempotencyScope: "s", configDigest: digest, expiresAt: new Date(Date.now() + 60000).toISOString(), effects: [], usage: { turns: 1, modelCalls: 1, providerAttempts: 1, toolCalls: 1, toolAttempts: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 10, elapsedMs: 10 }, pending: { approvals: [], inputs: [] } },
    retentionMs: 60000,
  });
  const claim = (await p.claim(runId, "crashed-worker", 5000))!;
  const toolDef = h.sf.i.registry.get(def.ref)!;
  const prepared = await h.sf.i.pipeline.prepare({ def: toolDef, inputs, principal: TEST_PRINCIPAL, runId, callId, agentId: "support", preset: "supervised" });
  await p.prepareBatch(runId, claim.epoch, [{ callId, runId, batchId: "b1", turn: 1, order: 0, toolRef: def.ref, state: "intent_committed", proposedArguments: inputs, invocation: prepared.invocation, intent: { at: nowIso(), attempt: 1, operationDigest: "sha256:op", idempotencyKey: "idem-1" }, attempts: [], createdAt: nowIso(), updatedAt: nowIso() }]);
  const transcript: NeutralMessage[] = [
    { role: "user", parts: [{ type: "text", text: "refund" }] },
    { role: "assistant", parts: [{ type: "tool_call", callId, toolRef: def.ref, alias: "refunds_request", arguments: inputs, providerCallId: "toolu_x" }] },
  ];
  const cp: Checkpoint = { runId, agentId: "support", configDigest: digest, pluginIdentities: {}, transcript, contextPacketIds: [], pendingBatch: { batchId: "b1", callIds: [callId], turn: 1 }, pendingApprovals: [], pendingInputs: [], reservationIds: [], counters: { turns: 1, modelCalls: 1, providerAttempts: 1, toolCalls: 1, toolAttempts: 0, inputTokens: 10, outputTokens: 5, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 10, repairs: 0, summarizations: 0, polls: 0, contextRefits: 0 }, loop: { seen: {}, warned: {}, pollCount: 0 }, batchResults: {}, startedAt: nowIso(), updatedAt: nowIso() };
  await p.saveCheckpoint(runId, claim.epoch, cp);
  await p.updateRun(runId, claim.epoch, { state: "suspended" });
  await p.release(claim);
  return runId;
}

test("crash after intent: reconciliation confirms the effect, the result is reused, and the tool is never re-executed", async () => {
  const calls: JsonObject[] = [];
  const h = await createHarness({
    config: cfg(),
    tools: [refundsTool(calls, "refund_status")],
    reconciliation: { refund_status: async ({ intent }) => ({ effect: "confirmed", output: { refund_id: `rf_from_${String(intent["idempotencyKey"])}`, status: "completed" } }) },
    script: [{ text: "Your refund rf_from_idem-1 is completed." }],
  });
  const runId = await crashedAfterIntent(h, { order_id: "A-1", amount_minor: 100 });
  const handle = await h.sf.runs.resume({ runId });
  const result = await handle.result();
  assert.equal(result.state, "completed");
  assert.equal(calls.length, 0, "no second dispatch");
  assert.equal(result.effects[0]!.outcome, "confirmed");
  const batch = h.provider.requests[0]!.messages.find((m) => m.role === "tool_results");
  assert.ok(batch && batch.role === "tool_results");
  assert.deepEqual(batch.results[0]!.content, { refund_id: "rf_from_idem-1", status: "completed" });
  await h.sf.close();
});

test("crash after intent without reconciliation: the run stays in reconciliation_required and never assumes no effect", async () => {
  const calls: JsonObject[] = [];
  const h = await createHarness({ config: cfg(), tools: [refundsTool(calls)], script: [{ text: "unreachable" }] });
  const runId = await crashedAfterIntent(h, { order_id: "A-1", amount_minor: 100 });
  const handle = await h.sf.runs.resume({ runId });
  const result = await handle.result();
  assert.equal(result.state, "reconciliation_required");
  assert.equal(calls.length, 0);
  assert.equal(h.provider.requests.length, 0, "no model call while the effect is unresolved");
  assert.equal(result.effects[0]!.outcome, "unknown");
  await h.sf.close();
});

test("two sessions compete for the same subject budget: the second run is refused once the period ceiling is reached", async () => {
  const h = await createHarness({
    config: baseConfig({ models: { default: { provider: "fake", model: "f", credential: { env: "FAKE_KEY" }, prices: { version: "v1", input_per_mtok: 1000000, output_per_mtok: 1000000 } } }, agents: { support: { instructions: "Help.", context: { output_reserve_tokens: 100 } } } }),
    script: [{ text: "ok" }],
    // Each turn reserves ~140 µUSD (≈40 input + 100 output) and settles 150; the second reservation exceeds 250.
    limits: { budgets: { subjectPeriodCostMicroUsd: 250, period: "day" } },
  });
  const s1 = await h.sf.sessions.open({ agent: "support" });
  const r1 = await (await s1.send({ message: { text: "one" } })).result();
  assert.equal(r1.state, "completed");
  assert.equal(r1.usage.costLabel, "priced");
  assert.ok(r1.usage.costMicroUsd > 0);
  const s2 = await h.sf.sessions.open({ agent: "support" });
  const r2 = await (await s2.send({ message: { text: "two" } })).result();
  assert.equal(r2.state, "budget_exhausted", JSON.stringify(r2));
  assert.match(r2.error!.message, /subject/);
  await h.sf.close();
});

test("a hook that changes approved arguments invalidates the approval: a new approval is required, nothing executes", async () => {
  const calls: JsonObject[] = [];
  const transport = new RecordingApprovalTransport();
  let prepares = 0;
  const h = await createHarness({
    config: cfg(),
    tools: [refundsTool(calls)],
    approvals: transport,
    hooks: [{ id: "drift", point: "prepareTool", timeoutMs: 100, onFailure: "fail", seesProtectedContent: false, buildIdentity: "t", prepareTool: async ({ inputs }) => (++prepares >= 2 ? { inputs: { ...inputs, amount_minor: 999999 } } : undefined) }],
    script: [{ toolCalls: [{ alias: "refunds_request", arguments: { order_id: "A-1", amount_minor: 100 } }] }, { text: "done" }],
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "refund" } });
  const first = await run.result();
  assert.equal(first.state, "waiting_approval");
  await h.sf.approvals.decide({ approvalId: first.pending!.approvals[0]!, actor: TEST_ACTOR, decision: "approve" });
  const resumed = await h.sf.runs.resume({ runId: run.id });
  const second = await resumed.result();
  assert.equal(second.state, "waiting_approval", "changed arguments need a fresh approval");
  assert.notEqual(second.pending!.approvals[0], first.pending!.approvals[0]);
  assert.equal(calls.length, 0);
  assert.equal(transport.requests.length, 2);
  await h.sf.close();
});

test("a fallback that cannot accept the data classification is not used", async () => {
  const primary = new FakeProvider([{ error: { code: "PROVIDER_REQUEST_REJECTED", message: "400", retryable: false } }, { text: "should not run" }]);
  const h = await createHarness({
    config: baseConfig({
      models: { default: { provider: "fake", model: "a", credential: { env: "FAKE_KEY" }, fallback: "backup" }, backup: { provider: "fake", model: "b", credential: { env: "FAKE_KEY" }, classification: "public" } },
      agents: { support: { instructions: "x" } },
    }),
    provider: primary,
  });
  const session = await h.sf.sessions.open({ agent: "support" });
  const result = await (await session.send({ message: { text: "confidential question" } })).result();
  assert.equal(result.state, "failed");
  assert.equal(primary.requests.length, 1, "fallback rejected before any request");
  await h.sf.close();
});

test("a forgotten preference is not resurrected by a stale indexing job", async () => {
  const repo = new InMemoryMemoryRepository();
  const index = new InMemoryMemoryIndex();
  const audit: unknown[] = [];
  const memory = new MemoryService({ repository: repo, index, artifacts: new InMemoryArtifactStore(), caps: { preferences: 10, facts: 10 }, retentionDays: { preferences: 365, facts: 30, conversation: 30 }, audit: async (r) => { audit.push(...r); } });
  const scope = { kind: "subject" as const, tenantId: "t1", subjectId: "u1" };
  const item = await memory.put(TEST_PRINCIPAL, { scope, kind: "preference", content: "Prefers email", origin: "user_explicit", provenance: [{ sourceType: "host", sourceId: "x", observedAt: nowIso() }] }, { idempotencyKey: "k1" });
  // Capture the upsert event a slow indexing job would still be holding.
  const staleEvent = { id: "stale", itemId: item.id, version: item.version, scopeKey: JSON.stringify(["subject", "t1", "u1"]), op: "upsert" as const, generation: 0, at: nowIso() };
  await memory.forget(TEST_PRINCIPAL, { id: item.id }, { idempotencyKey: "d1" });
  await index.applyOutbox("t1", [staleEvent], async () => ({ ...item }));
  const hits = await index.search("t1", staleEvent.scopeKey, "email", 5);
  assert.deepEqual(hits, [], "stale job must check the deletion generation before writing");
  assert.ok(audit.some((a) => (a as { type: string }).type === "memory_outbox"), "outbox events are mirrored into audit");
});

test("expired approval cannot be decided or dispatched", async () => {
  const calls: JsonObject[] = [];
  const transport = new RecordingApprovalTransport();
  const h = await createHarness({ config: cfg(), tools: [refundsTool(calls)], approvals: transport, limits: { approvalExpirySeconds: 1 }, script: [{ toolCalls: [{ alias: "refunds_request", arguments: { order_id: "A-1", amount_minor: 100 } }] }, { text: "x" }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "refund" } });
  const parked = await run.result();
  assert.equal(parked.state, "waiting_approval");
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(h.sf.approvals.decide({ approvalId: parked.pending!.approvals[0]!, actor: TEST_ACTOR, decision: "approve" }), (e: unknown) => SFieldError.is(e, "APPROVAL_EXPIRED"));
  assert.equal(calls.length, 0);
  await h.sf.close();
});
