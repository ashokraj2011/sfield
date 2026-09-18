import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, SFieldError, buildContext, RetrievalService, ToolError } from "@sfield/core";
import type { JsonObject, RetrievalBinding, RetrievedItem, EffectiveAgentConfig, ModelBinding, ModelCapabilities } from "@sfield/core";
import { baseConfig, createHarness, TEST_PRINCIPAL } from "../harness.js";

const scope = { kind: "subject" as const, tenantId: "t1", subjectId: "u1" };
const prov = () => [{ sourceType: "host" as const, sourceId: "import", observedAt: new Date().toISOString() }];

test("memory: explicit put/update/forget with caps, version conflicts, supersession, and secret rejection", async () => {
  const h = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x" } } }), limits: { memoryCaps: { preferences: 2, facts: 1 } } });
  const m = h.sf.memory.for();
  const a = await m.put({ scope, kind: "preference", content: "Prefers email", structured: { key: "channel", value: "email" }, origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k1" });
  const again = await m.put({ scope, kind: "preference", content: "Prefers email", structured: { key: "channel", value: "email" }, origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k1" });
  assert.equal(again.id, a.id, "idempotent create");
  const b = await m.put({ scope, kind: "preference", content: "Prefers SMS", structured: { key: "channel", value: "sms" }, origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k2" });
  assert.equal(b.supersedes, a.id);
  assert.equal((await m.get(a.id))!.status, "superseded");
  assert.equal((await m.list({ kind: "preference" })).items.length, 1);
  await m.put({ scope, kind: "preference", content: "Formal tone", origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k3" });
  await assert.rejects(m.put({ scope, kind: "preference", content: "Third", origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k4" }), (e: unknown) => SFieldError.is(e, "MEMORY_CAPACITY"));
  const updated = await m.update(b.id, { content: "Prefers SMS after 6pm" }, { ifVersion: b.version });
  assert.equal(updated.version, "2");
  await assert.rejects(m.update(b.id, { content: "stale" }, { ifVersion: b.version }), (e: unknown) => SFieldError.is(e, "VERSION_CONFLICT"));
  await assert.rejects(m.put({ scope, kind: "preference", content: "api_key: sk-abcdefghijklmnopqrstuvwxyz", origin: "user_explicit", provenance: prov() }, { idempotencyKey: "k5" }), (e: unknown) => SFieldError.is(e, "INVALID_INPUT"));
  const other = h.sf.memory.for({ tenantId: "t1", subjectId: "someone-else", roles: [], attributes: {} });
  await assert.rejects(other.get(b.id), (e: unknown) => SFieldError.is(e, "ACCESS_DENIED"));
  const receipt = await m.forget({ id: b.id }, { idempotencyKey: "d1" });
  assert.equal(receipt.count, 1);
  assert.equal(await m.get(b.id), null);
  const same = await m.forget({ id: b.id }, { idempotencyKey: "d1" });
  assert.equal(same.count, 1, "deletion receipt idempotent");
  assert.ok(m.capabilities().physical.canonical === "immediate");
  const audit = await h.sf.audit.read({ type: "memory_forget" });
  assert.ok(audit.length >= 1);
  await h.sf.close();
});

function agentCfg(extra: Partial<EffectiveAgentConfig> = {}): EffectiveAgentConfig {
  return {
    id: "a",
    model: "default",
    instructions: "Be brief.",
    tools: [],
    memory: { conversation: true, preferences: "explicit", facts: "off", retention_days: { conversation: 30, preferences: 365, facts: 30 } },
    context: { max_input_tokens: 400, output_reserve_tokens: 100, max_tools: 24, sources: [], priority: ["history", "preferences", "facts", "retrieval", "summary"] },
    policy: { preset: "supervised" },
    budget: { max_turns: 20, max_model_calls: 30, max_provider_attempts: 40, max_tool_calls: 50, max_tool_attempts: 60, max_tokens: 200000, max_cost_microusd: 1000000, max_active_seconds: 300, max_elapsed_seconds: 86400 },
    output: { max_repairs: 1, stream: true },
    runtime: { loop_detection: { enabled: true, identical_call_window: 3, on_first: "warn", on_repeat: "fail", max_polls_per_run: 20 } },
    extensions: {},
    ...extra,
  };
}

const mb: ModelBinding = { identity: { id: "m", revision: "1", accountScope: "a", classification: "restricted" }, provider: "fake", model: "f", acceptsClassification: "restricted", limits: { contextWindow: 100000, maxOutputTokens: 1000 }, supportedParams: [] };
const caps: ModelCapabilities = { inputLimit: 100000, outputLimit: 1000, toolUse: true, structuredOutput: "json_schema", strictTools: true, streamingUsage: true, media: [], opaqueContinuation: false, tokenCounting: "estimated", continueStopReason: false };

function source(items: RetrievedItem[], opts: { fail?: boolean; unauthorized?: string[]; delayMs?: number } = {}): RetrievalBinding {
  return {
    identity: { id: "src", revision: "1", accountScope: "a", classification: "internal" },
    async search(q) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error("boom");
      return { items: items.slice(0, q.maxItems), partial: false };
    },
    async authorizeItem(item) {
      return !(opts.unauthorized ?? []).includes(item.id);
    },
  };
}

const item = (id: string, text: string): RetrievedItem => ({ id, sourceId: "kb", sourceVersion: "v1", title: `Doc ${id}`, text, citation: { label: `Doc ${id}`, uri: `kb://${id}` }, classification: "internal", observedAt: new Date().toISOString(), aclEvidence: "test" });

test("context: required blocks preserved, optional history dropped oldest-first with omissions, citations assigned, unauthorized hits hidden", async () => {
  const retrieval = new RetrievalService(new Map([["kb", source([item("1", "Refunds within 30 days."), item("2", "Secret doc"), item("3", "Exchanges within 60 days.")], { unauthorized: ["2"] })]]));
  const agent = agentCfg({ context: { ...agentCfg().context, max_input_tokens: 320, sources: [{ source: "kb", query: { ref: "message.text" }, max_items: 5, max_tokens: 200, required: false, timeout_ms: 1000 }] } });
  const transcript = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", parts: [{ type: "text" as const, text: `message ${i} ${"lorem ipsum ".repeat(8)}` }] }));
  const out = await buildContext({ runId: "r", agent, principal: TEST_PRINCIPAL, message: { text: "refund policy?" }, transcript, binding: mb, capabilities: caps, tools: [], memory: { preferences: [], facts: [], summaries: [] }, retrieval });
  assert.ok(out.packet.blocks.some((b) => b.kind === "instruction" && b.required));
  assert.ok(out.packet.blocks.some((b) => b.kind === "current_message" && b.required));
  const historyKept = out.packet.blocks.filter((b) => b.kind === "history");
  assert.ok(historyKept.length < 12 && historyKept.length > 0, `expected some history dropped, kept ${historyKept.length}`);
  const keptRanks = historyKept.map((b) => b.rank!);
  assert.equal(Math.max(...keptRanks), 11, "newest history kept");
  assert.ok(out.packet.omissions.some((o) => o.reason === "token_budget"));
  assert.ok(out.packet.omissions.some((o) => o.reason === "not_authorized"), "unauthorized hit recorded non-disclosingly");
  assert.ok(!JSON.stringify(out.request).includes("Secret doc"));
  assert.deepEqual(Object.keys(out.packet.citations), ["source_1", "source_2"]);
  assert.ok(out.packet.budget.estimatedInput <= out.packet.budget.inputLimit);
  assert.equal(out.explanation.included.length, out.packet.blocks.length);
  // Retrieval lands in the user channel as labeled reference data, never in instructions.
  assert.deepEqual(out.request.instructions, ["Be brief."]);
  const last = out.request.messages[out.request.messages.length - 1]!;
  assert.ok(last.role === "user" && last.parts[0]!.type === "text" && last.parts[0]!.text.includes('<reference_data kind="retrieved"'));
});

test("context: a required source failure fails preparation; an optional failure is an explicit omission; CONTEXT_LIMIT when mandatory content cannot fit", async () => {
  const failing = new RetrievalService(new Map([["kb", source([], { fail: true })]]));
  const required = agentCfg({ context: { ...agentCfg().context, sources: [{ source: "kb", query: { ref: "message.text" }, max_items: 5, max_tokens: 200, required: true, timeout_ms: 1000 }] } });
  await assert.rejects(buildContext({ runId: "r", agent: required, principal: TEST_PRINCIPAL, message: { text: "q" }, transcript: [], binding: mb, capabilities: caps, tools: [], memory: { preferences: [], facts: [], summaries: [] }, retrieval: failing }), (e: unknown) => SFieldError.is(e, "REQUIRED_CONTEXT_UNAVAILABLE"));
  const optional = agentCfg({ context: { ...agentCfg().context, sources: [{ source: "kb", query: { ref: "message.text" }, max_items: 5, max_tokens: 200, required: false, timeout_ms: 1000 }] } });
  const out = await buildContext({ runId: "r", agent: optional, principal: TEST_PRINCIPAL, message: { text: "q" }, transcript: [], binding: mb, capabilities: caps, tools: [], memory: { preferences: [], facts: [], summaries: [] }, retrieval: failing });
  assert.ok(out.packet.omissions.some((o) => o.sourceId === "kb" && o.reason === "source_unavailable"));
  const slow = new RetrievalService(new Map([["kb", source([item("1", "x")], { delayMs: 300 })]]));
  const timeoutCfg = agentCfg({ context: { ...agentCfg().context, sources: [{ source: "kb", query: { ref: "message.text" }, max_items: 5, max_tokens: 200, required: false, timeout_ms: 20 }] } });
  const out2 = await buildContext({ runId: "r", agent: timeoutCfg, principal: TEST_PRINCIPAL, message: { text: "q" }, transcript: [], binding: mb, capabilities: caps, tools: [], memory: { preferences: [], facts: [], summaries: [] }, retrieval: slow });
  assert.ok(out2.packet.omissions.some((o) => o.reason === "source_timeout"));
  const tiny = agentCfg({ context: { ...agentCfg().context, max_input_tokens: 20 } });
  await assert.rejects(buildContext({ runId: "r", agent: tiny, principal: TEST_PRINCIPAL, message: { text: "a very long message ".repeat(20) }, transcript: [], binding: mb, capabilities: caps, tools: [], memory: { preferences: [], facts: [], summaries: [] }, retrieval: failing }), (e: unknown) => SFieldError.is(e, "CONTEXT_LIMIT"));
});

test("pipeline: confirmed mutation with malformed output is failed but its effect stays confirmed and is never retried", async () => {
  let executions = 0;
  const tool = defineTool({
    id: "billing.charge",
    version: "1.0.0",
    description: "Charge",
    inputs: { type: "object", additionalProperties: false, required: ["amount"], properties: { amount: { type: "integer" } } },
    outputs: { type: "object", additionalProperties: false, required: ["charge_id"], properties: { charge_id: { type: "string" } } },
    resource: { type: "account", id: { literal: "acct-1" } },
    policy: { effect: "write", action: "billing.charge", retrySafety: "repeatable", maxAttempts: 3 },
    async handler() {
      executions++;
      return { unexpected: true } as unknown as JsonObject;
    },
  });
  const h = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x", tools: ["billing.charge"] } } }), tools: [tool], limits: { grants: { autonomousWrites: true } } });
  const scope = await h.sf.executions.open({ purpose: "test", preset: "bounded_auto" });
  const res = await scope.registry.execute("billing.charge", { amount: 5 });
  assert.equal(res.status, "failed");
  assert.equal(res.error?.code, "INVALID_OUTPUT");
  assert.equal(res.effect, "confirmed");
  assert.equal(executions, 1, "a confirmed mutation is not retried");
  const closed = await scope.close();
  assert.equal(closed.effects[0]!.outcome, "confirmed");
  await h.sf.close();
});

test("pipeline: a mutation whose handler throws without effect knowledge is outcome_unknown and needs reconciliation", async () => {
  const tool = defineTool({
    id: "ledger.post",
    version: "1.0.0",
    description: "Post",
    inputs: { type: "object", additionalProperties: false, properties: {} },
    outputs: { type: "object", additionalProperties: false, properties: {} },
    resource: { type: "ledger", id: { literal: "L1" } },
    policy: { effect: "write", action: "ledger.post" },
    async handler() {
      throw new Error("socket hang up");
    },
  });
  const h = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x", tools: ["ledger.post"] } } }), tools: [tool], limits: { grants: { autonomousWrites: true } } });
  const scope = await h.sf.executions.open({ purpose: "t", preset: "bounded_auto" });
  const res = await scope.registry.execute("ledger.post", {});
  assert.equal(res.status, "outcome_unknown");
  assert.equal(res.effect, "unknown");
  const closed = await scope.close();
  assert.equal(closed.state, "reconciliation_required");
  const explicit = defineTool({ ...tool, id: "ledger.post2", handler: async () => { throw new ToolError("DOWN", "not sent", { effect: "none" }); } } as Parameters<typeof defineTool>[0]);
  const h2 = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x", tools: ["ledger.post2"] } } }), tools: [explicit], limits: { grants: { autonomousWrites: true } } });
  const s2 = await h2.sf.executions.open({ purpose: "t", preset: "bounded_auto" });
  const r2 = await s2.registry.execute("ledger.post2", {});
  assert.equal(r2.status, "failed");
  assert.equal(r2.effect, "none");
  await s2.close();
  await h.sf.close();
  await h2.sf.close();
});

test("pipeline: hook-changed inputs are revalidated; authorizer denial fails closed; prerequisites gate mutations", async () => {
  let prereqCalls = 0;
  const tool = defineTool({
    id: "refunds.request",
    version: "1.0.0",
    description: "Refund",
    inputs: { type: "object", additionalProperties: false, required: ["order_id", "amount_minor"], properties: { order_id: { type: "string" }, amount_minor: { type: "integer", minimum: 1 } } },
    outputs: { type: "object", additionalProperties: false, properties: {} },
    resource: { type: "order", id: { ref: "inputs.order_id" } },
    policy: { effect: "write", action: "refund.request", prerequisite: "refundEligibility" },
    async handler() {
      return {};
    },
  });
  const h = await createHarness({
    config: baseConfig({ agents: { a: { instructions: "x", tools: ["refunds.request"] } } }),
    tools: [tool],
    limits: { grants: { autonomousWrites: true } },
    prerequisites: { refundEligibility: async (req) => { prereqCalls++; return Number((req.inputs as JsonObject)["amount_minor"]) <= 1000 ? { ok: true, evidenceId: `elig:${req.argumentsDigest}`, expiresAt: new Date(Date.now() + 60000).toISOString() } : { ok: false, code: "NOT_ELIGIBLE", reason: "amount exceeds eligibility" }; } },
    hooks: [{ id: "cap", point: "prepareTool", timeoutMs: 100, onFailure: "fail", seesProtectedContent: false, buildIdentity: "test", prepareTool: async ({ inputs }) => ({ inputs: { ...inputs, amount_minor: -5 } }) }],
  });
  const scope = await h.sf.executions.open({ purpose: "t", preset: "bounded_auto" });
  await assert.rejects(scope.registry.execute("refunds.request", { order_id: "A", amount_minor: 10 }), (e: unknown) => SFieldError.is(e, "INVALID_INPUT") && /hook cap/.test((e as Error).message));
  await scope.close();
  await h.sf.close();
  const h2 = await createHarness({
    config: baseConfig({ agents: { a: { instructions: "x", tools: ["refunds.request"] } } }),
    tools: [tool],
    limits: { grants: { autonomousWrites: true } },
    prerequisites: { refundEligibility: async (req) => { prereqCalls++; return Number((req.inputs as JsonObject)["amount_minor"]) <= 1000 ? { ok: true, evidenceId: `elig:${req.argumentsDigest}`, expiresAt: new Date(Date.now() + 60000).toISOString() } : { ok: false, code: "NOT_ELIGIBLE", reason: "amount exceeds eligibility" }; } },
  });
  const s2 = await h2.sf.executions.open({ purpose: "t", preset: "bounded_auto" });
  await assert.rejects(s2.registry.execute("refunds.request", { order_id: "A", amount_minor: 5000 }), (e: unknown) => SFieldError.is(e, "PREREQUISITE_FAILED"));
  const ok = await s2.registry.execute("refunds.request", { order_id: "A", amount_minor: 500 });
  assert.equal(ok.status, "succeeded");
  assert.equal(prereqCalls, 2);
  await s2.close();
  await h2.sf.close();
  const denying = { authorize: async () => ({ decision: "deny" as const, code: "ACCESS_DENIED", reason: "no" }) };
  const h3 = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x", tools: ["refunds.request"] } } }), tools: [tool], authorizer: denying, prerequisites: { refundEligibility: async () => ({ ok: true, evidenceId: "e", expiresAt: new Date(Date.now() + 60000).toISOString() }) } });
  const s3 = await h3.sf.executions.open({ purpose: "t" });
  await assert.rejects(s3.registry.execute("refunds.request", { order_id: "A", amount_minor: 5 }), (e: unknown) => SFieldError.is(e, "ACCESS_DENIED"));
  await s3.close();
  await h3.sf.close();
});

test("large canonical results become artifacts while the model sees a labeled partial view", async () => {
  const tool = defineTool({
    id: "reports.big",
    version: "1.0.0",
    description: "Big",
    inputs: { type: "object", additionalProperties: false, properties: {} },
    outputs: { type: "object", additionalProperties: false, required: ["rows"], properties: { rows: { type: "array", items: { type: "string" } } } },
    policy: { effect: "read", maxOutputBytes: 1_000_000 },
    async handler() {
      return { rows: Array.from({ length: 2000 }, (_, i) => `row-${i}-${"x".repeat(40)}`) };
    },
  });
  const h = await createHarness({ config: baseConfig({ agents: { a: { instructions: "x", tools: ["reports.big"] } } }), tools: [tool] });
  const scope = await h.sf.executions.open({ purpose: "t" });
  const res = await scope.registry.execute("reports.big", {});
  assert.equal(res.status, "succeeded");
  assert.ok(res.outputRef, "stored as artifact");
  assert.equal(res.output, undefined);
  await scope.close();
  await h.sf.close();
});
