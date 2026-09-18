import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalRecord, CallRecord, Checkpoint, ContextExplanation, MemoryFilter, MemoryItem, MemoryScope, ModelAttemptRecord, PageRequest, RunEvent, RunRecord, ToolResult } from "@sfield/core";
import { SFieldError, emptyLoopState, scopeKey } from "@sfield/core";
import { persistenceConformance } from "@sfield/testing";
import { SCHEMA_VERSION, sqlitePersistence, type SqlitePersistence } from "./index.js";

const NS = { namespace: "test", ownerId: "owner-1" };
const ACTOR = { tenantId: "t", subjectId: "approver" };
const SUBJECT: MemoryScope = { kind: "subject", tenantId: "t", subjectId: "s" };

function tmpPath(): string {
  // Nested, not-yet-existing directories: init must create them.
  return join(mkdtempSync(join(tmpdir(), "sfield-sqlite-")), "nested", "dir", "store.sqlite");
}

function future(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

async function open(path = tmpPath(), opts: { eventRetention?: number } = {}): Promise<SqlitePersistence> {
  const p = sqlitePersistence({ path, ...opts });
  await p.init(NS);
  return p;
}

function is(code: string): (err: unknown) => boolean {
  return (err) => SFieldError.is(err, code);
}

function runRecord(runId: string, scopeId = runId): Omit<RunRecord, "epoch" | "lastEventSeq" | "updatedAt" | "createdAt"> {
  return {
    runId,
    tenantId: "t",
    subjectId: "s",
    principal: { tenantId: "t", subjectId: "s", roles: [], attributes: {} },
    agentId: "a",
    kind: "standalone",
    scopeId,
    state: "queued",
    request: { message: { text: "hi" } },
    requestDigest: `sha256:${runId}`,
    idempotencyKey: `key-${runId}`,
    idempotencyScope: "scope",
    configDigest: "sha256:cfg",
    expiresAt: future(),
    effects: [],
    usage: { turns: 0, modelCalls: 0, providerAttempts: 0, toolCalls: 0, toolAttempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 0, elapsedMs: 0 },
    pending: { approvals: [], inputs: [] },
  };
}

function event(runId: string, type: string): RunEvent {
  return { v: 1, id: `evt-${type}-${Math.random().toString(36).slice(2, 10)}`, runId, timestamp: new Date().toISOString(), type, payload: {} };
}

function checkpoint(runId: string): Checkpoint {
  const now = new Date().toISOString();
  return {
    runId,
    agentId: "a",
    configDigest: "sha256:cfg",
    pluginIdentities: { "tool-a": "sha256:plugin" },
    transcript: [],
    contextPacketIds: ["ctx-1"],
    pendingApprovals: [],
    pendingInputs: [],
    reservationIds: ["rsv-1"],
    counters: { turns: 1, modelCalls: 1, providerAttempts: 1, toolCalls: 0, toolAttempts: 0, inputTokens: 10, outputTokens: 5, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 5, repairs: 0, summarizations: 0, polls: 0, contextRefits: 0 },
    loop: emptyLoopState(),
    batchResults: {},
    continuation: { reason: "suspend", since: now },
    startedAt: now,
    updatedAt: now,
  };
}

function approval(id: string, runId: string, callIds: string[]): ApprovalRecord {
  return { id, tenantId: "t", runId, callIds, preparedDigests: callIds.map((c) => `sha256:${c}`), requesterSubjectId: "s", allowedApproverPolicyId: "host", view: [], expiresAt: future(), maxUses: 1, status: "pending", createdAt: new Date().toISOString() };
}

function memoryItem(id: string, over: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id,
    version: "v1",
    scope: SUBJECT,
    kind: "preference",
    content: `Prefers ${id}`,
    origin: "user_explicit",
    provenance: [{ sourceType: "message", sourceId: "m1", observedAt: now }],
    classification: "internal",
    expiresAt: future(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// (a) The §17.2 conformance suite, one fresh database per case.
for (const c of persistenceConformance(() => open())) {
  test(`sqlite persistence conformance: ${c.name}`, () => c.run());
}

// (b) Restart durability.
test("restart durability: runs, checkpoints, events, and leases survive close and reopen", async () => {
  const path = tmpPath();
  const p1 = sqlitePersistence({ path });
  await p1.init({ namespace: "ns", ownerId: "o1" });
  const accepted = await p1.acceptRequest({ run: runRecord("r1"), retentionMs: 60_000 });
  assert.equal(accepted.created, true);
  assert.equal(accepted.run.wakeup?.reason, "accepted");
  const claim = await p1.claim("r1", "o1", 5000);
  assert.ok(claim);
  await p1.updateRun("r1", claim.epoch, { state: "running", wakeup: null });
  const cp = checkpoint("r1");
  await p1.saveCheckpoint("r1", claim.epoch, cp);
  const appended = await p1.appendEvents("r1", claim.epoch, [event("r1", "a"), event("r1", "b")]);
  assert.deepEqual(appended.map((e) => e.seq), [1, 2]);
  await p1.close();
  assert.equal((await p1.health()).ok, false);
  await assert.rejects(p1.getRun("r1"), is("STATE_UNAVAILABLE"));

  const p2 = sqlitePersistence({ path });
  await p2.init({ namespace: "ns", ownerId: "o2" }); // the first owner released the namespace on close
  assert.equal((await p2.health()).ok, true);
  const run = await p2.getRun("r1");
  assert.equal(run?.state, "running");
  assert.equal(run?.lastEventSeq, 2);
  assert.equal(run?.epoch, claim.epoch);
  assert.equal(run?.wakeup, null);
  assert.deepEqual(await p2.listWakeups(), []);
  assert.deepEqual(await p2.getCheckpoint("r1"), cp);
  const read = await p2.readEvents("r1", 0);
  assert.deepEqual(read.events.map((e) => [e.seq, e.type]), [[1, "a"], [2, "b"]]);
  assert.equal(read.lastSeq, 2);
  assert.equal(read.gap, false);
  // The execution lease is durable too: another owner waits for expiry while the original keeps its epoch (§17.3).
  assert.equal((await p2.currentOwner("r1"))?.ownerId, "o1");
  assert.equal(await p2.claim("r1", "o2", 1000), null);
  assert.equal((await p2.claim("r1", "o1", 1000))?.epoch, claim.epoch);
  await assert.rejects(p2.updateRun("r1", claim.epoch + 1, { state: "completed" }), is("OWNERSHIP_LOST"));
  // Idempotent accept survives restart as well.
  const replay = await p2.acceptRequest({ run: runRecord("r1"), retentionMs: 60_000 });
  assert.equal(replay.created, false);
  assert.equal(replay.run.state, "running");
  await assert.rejects(p2.acceptRequest({ run: { ...runRecord("r1"), requestDigest: "sha256:other" }, retentionMs: 60_000 }), is("IDEMPOTENCY_CONFLICT"));
  await p2.close();
});

// (c) Exclusive ownership per deployment namespace (§17.1).
test("exclusive ownership: a second owner cannot init while the first is open; dead or stale owners are taken over", async () => {
  const path = tmpPath();
  const p1 = sqlitePersistence({ path });
  await p1.init({ namespace: "ns", ownerId: "a" });
  const p2 = sqlitePersistence({ path });
  await assert.rejects(p2.init({ namespace: "ns", ownerId: "b" }), is("OWNERSHIP_UNAVAILABLE"));
  assert.equal((await p2.health()).ok, false);
  assert.equal((await p1.health()).ok, true);
  // Another namespace in the same file is independent.
  const other = sqlitePersistence({ path });
  await other.init({ namespace: "other", ownerId: "b" });
  assert.equal((await other.health()).ok, true);
  await other.close();
  await p1.close();
  await p2.init({ namespace: "ns", ownerId: "b" });
  assert.equal((await p2.health()).ok, true);
  await p2.close();

  const setOwner = (ownerId: string, pid: number, heartbeatAt: number): void => {
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO owners (namespace, owner_id, pid, heartbeat_at) VALUES ('ns', ?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at").run(ownerId, pid, heartbeatAt);
    raw.close();
  };
  // A fresh heartbeat from a dead pid is taken over.
  setOwner("ghost", 2_147_483_000, Date.now());
  const p3 = sqlitePersistence({ path });
  await p3.init({ namespace: "ns", ownerId: "c" });
  await p3.close();
  // A live pid with a stale heartbeat is taken over as well.
  setOwner("sleeper", process.pid, Date.now() - 60_000);
  const p4 = sqlitePersistence({ path });
  await p4.init({ namespace: "ns", ownerId: "d" });
  // A live pid with a fresh heartbeat is not.
  setOwner("awake", process.pid, Date.now());
  const p5 = sqlitePersistence({ path });
  await assert.rejects(p5.init({ namespace: "ns", ownerId: "e" }), is("OWNERSHIP_UNAVAILABLE"));
  await p4.close();
});

test("init refuses a database written by a newer schema version", async () => {
  const path = tmpPath();
  const p = await open(path);
  await p.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE sfield_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  raw.close();
  const p2 = sqlitePersistence({ path });
  await assert.rejects(p2.init(NS), is("UNSUPPORTED_DEPLOYMENT"));
  assert.equal((await p2.health()).ok, false);
});

test("':memory:' databases work and operations before init fail closed", async () => {
  const p = sqlitePersistence({ path: ":memory:" });
  await assert.rejects(p.getRun("x"), is("STATE_UNAVAILABLE"));
  await p.init(NS);
  assert.equal((await p.acceptRequest({ run: runRecord("r1"), retentionMs: 1000 })).created, true);
  assert.equal((await p.health()).ok, true);
  await p.close();
});

// (d) Memory repository (§17.5).
test("memory repository: idempotent create, CAS update, list filters, deletion generations, outbox", async () => {
  const p = await open();
  const m = p.memory;
  const t0 = "2026-01-01T00:00:00.000Z";
  const first = await m.create("t", memoryItem("m1", { structured: { key: "color", value: "blue" }, updatedAt: t0 }), "k1");
  assert.equal(first.created, true);
  const replay = await m.create("t", memoryItem("m1-dup"), "k1");
  assert.equal(replay.created, false);
  assert.equal(replay.item.id, "m1");
  assert.equal(await m.get("t", "m1-dup"), null);
  assert.equal(await m.get("other-tenant", "m1"), null);

  const updated = await m.update("t", "m1", "v1", { ...first.item, version: "v2", content: "Prefers GREEN tea", updatedAt: "2026-01-03T00:00:00.000Z" });
  assert.equal(updated.version, "v2");
  await assert.rejects(m.update("t", "m1", "v1", { ...updated, version: "v3" }), is("VERSION_CONFLICT"));
  await assert.rejects(m.update("t", "missing", "v1", updated), is("NOT_FOUND"));
  assert.equal((await m.get("t", "m1"))?.content, "Prefers GREEN tea");

  await m.create("t", memoryItem("m2", { kind: "fact", content: "The sky is blue", updatedAt: "2026-01-02T00:00:00.000Z" }), "k2");
  await m.create("t", memoryItem("m3", { expiresAt: "2000-01-01T00:00:00.000Z", updatedAt: t0 }), "k3");
  await m.create("t", memoryItem("m4", { status: "superseded", updatedAt: t0 }), "k4");
  await m.create("t", memoryItem("m5", { scope: { kind: "conversation", tenantId: "t", conversationId: "c1" }, updatedAt: t0 }), "k5");
  await m.create("t2", memoryItem("m6", { updatedAt: t0 }), "k6");

  const ids = async (filter: MemoryFilter, page?: PageRequest): Promise<string[]> => (await m.list("t", filter, page)).items.map((i) => i.id);
  assert.deepEqual(await ids({}), ["m1", "m2", "m5"]); // active and unexpired, newest first; other tenants invisible
  assert.deepEqual(await ids({ scope: SUBJECT }), ["m1", "m2"]);
  assert.deepEqual(await ids({ kind: "fact" }), ["m2"]);
  assert.deepEqual(await ids({ kind: ["fact", "preference"], scope: SUBJECT }), ["m1", "m2"]);
  assert.deepEqual(await ids({ status: "superseded" }), ["m4"]);
  assert.deepEqual(await ids({ key: "color" }), ["m1"]);
  assert.deepEqual(await ids({ text: "green" }), ["m1"]);
  assert.deepEqual(await ids({ includeExpired: true, scope: SUBJECT }), ["m1", "m2", "m3"]);
  const page1 = await m.list("t", {}, { limit: 2 });
  assert.deepEqual(page1.items.map((i) => i.id), ["m1", "m2"]);
  assert.equal(page1.nextCursor, "2");
  const page2 = await m.list("t", {}, { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((i) => i.id), ["m5"]);
  assert.equal(page2.nextCursor, undefined);
  assert.equal(await m.countActive("t", SUBJECT, "preference"), 1);
  assert.equal(await m.countActive("t", SUBJECT, "fact"), 1);

  assert.equal(await m.generation("t", scopeKey(SUBJECT)), 0);
  assert.deepEqual(await m.delete("t", ["m1", "does-not-exist"], "del-1"), { generation: 1, count: 1 });
  assert.deepEqual(await m.delete("t", ["m2"], "del-1"), { generation: 1, count: 1 }); // idempotent by key: m2 untouched
  assert.equal(await m.generation("t", scopeKey(SUBJECT)), 1);
  assert.equal(await m.get("t", "m1"), null);
  assert.equal((await m.get("t", "m2"))?.id, "m2");
  assert.deepEqual(await m.delete("t", ["m2"], "del-2"), { generation: 2, count: 1 });

  const outbox = await m.drainOutbox(100);
  assert.deepEqual(
    outbox.map((e) => [e.op, e.itemId, e.generation]),
    [["upsert", "m1", 0], ["upsert", "m1", 0], ["upsert", "m2", 0], ["upsert", "m3", 0], ["upsert", "m4", 0], ["upsert", "m5", 0], ["upsert", "m6", 0], ["delete", "m1", 1], ["delete", "m2", 2]],
  );
  assert.equal(outbox[7]?.scopeKey, scopeKey(SUBJECT));
  assert.equal((await m.drainOutbox(2)).length, 2);
  await m.ackOutbox(outbox.slice(0, 7).map((e) => e.id));
  assert.deepEqual((await m.drainOutbox(100)).map((e) => e.op), ["delete", "delete"]);
  await p.close();
});

// (e) Reservations and scope usage (§15.2, §15.3).
test("reservations: scopeUsage sums held and settled correctly after settle", async () => {
  const p = await open();
  await p.acceptRequest({ run: runRecord("r1"), retentionMs: 60_000 });
  const base = { runId: "r1", tenantId: "t", subjectId: "s", kind: "model" as const, estimateMicroUsd: 600, scopes: [] as string[] };
  const a = await p.reserve(base, [{ key: "run:r1", ceilingMicroUsd: 1000 }, { key: "tenant:t", ceilingMicroUsd: 5000 }]);
  const b = await p.reserve({ ...base, estimateMicroUsd: 300 }, [{ key: "run:r1", ceilingMicroUsd: 1000 }]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const aId = (a as { id: string }).id;
  const bId = (b as { id: string }).id;
  assert.deepEqual(await p.scopeUsage("run:r1"), { heldMicroUsd: 900, settledMicroUsd: 0 });
  assert.deepEqual(await p.scopeUsage("tenant:t"), { heldMicroUsd: 600, settledMicroUsd: 0 });
  assert.deepEqual(await p.scopeUsage("nobody"), { heldMicroUsd: 0, settledMicroUsd: 0 });
  const over = await p.reserve({ ...base, estimateMicroUsd: 101 }, [{ key: "run:r1", ceilingMicroUsd: 1000 }]);
  assert.ok(!over.ok && over.code === "BUDGET_EXHAUSTED");
  await p.settle(aId, 100, "settled");
  assert.deepEqual(await p.scopeUsage("run:r1"), { heldMicroUsd: 300, settledMicroUsd: 100 });
  assert.deepEqual(await p.scopeUsage("tenant:t"), { heldMicroUsd: 0, settledMicroUsd: 100 });
  await p.settle(bId, 450, "uncertain");
  assert.deepEqual(await p.scopeUsage("run:r1"), { heldMicroUsd: 450, settledMicroUsd: 100 }); // uncertain holds max(estimate, actual)
  await p.settle(bId, 450, "settled");
  assert.deepEqual(await p.scopeUsage("run:r1"), { heldMicroUsd: 0, settledMicroUsd: 550 });
  await p.settle(aId, 999, "released"); // idempotent once settled
  const rec = await p.getReservation(aId);
  assert.equal(rec?.state, "settled");
  assert.equal(rec?.actualMicroUsd, 100);
  assert.deepEqual(rec?.scopes, ["run:r1", "tenant:t"]);
  await assert.rejects(p.settle("missing", 0, "settled"), is("NOT_FOUND"));
  await p.close();
});

// Domain semantics beyond the conformance suite: call transitions, approvals, inputs, conversation CAS, messages, retention, sub-stores.
test("call transitions, approvals, inputs, conversation CAS, messages, event retention, and sub-stores", async () => {
  const p = await open(tmpPath(), { eventRetention: 2 });
  const now = new Date().toISOString();
  await p.createConversation({ id: "c1", tenantId: "t", subjectId: "s", agentId: "a", createdAt: now, updatedAt: now, messageCount: 0 });
  await p.acceptRequest({
    run: { ...runRecord("r1", "c1"), kind: "session", conversationId: "c1" },
    message: { conversationId: "c1", tenantId: "t", runId: "r1", role: "user", content: { text: "hi" }, createdAt: now, expiresAt: future() },
    retentionMs: 60_000,
  });
  assert.equal((await p.getConversation("c1"))?.messageCount, 1);
  const claim = await p.claim("c1", "w", 5000);
  assert.ok(claim);

  // Calls: prepared -> ready (authorize + reserve) -> intent_committed -> succeeded (§16.3).
  const call: CallRecord = { callId: "call-1", runId: "r1", batchId: "b1", turn: 1, order: 0, toolRef: "tool", state: "prepared", proposedArguments: { q: 1 }, attempts: [], createdAt: now, updatedAt: now };
  await p.prepareBatch("r1", claim.epoch, [call, { ...call, callId: "call-2", order: 1 }]);
  assert.deepEqual((await p.listCalls("r1")).map((c) => c.callId), ["call-1", "call-2"]);
  await assert.rejects(p.prepareBatch("r1", claim.epoch + 1, [call]), is("OWNERSHIP_LOST"));
  const intent = { at: now, attempt: 1, operationDigest: "sha256:op" };
  await assert.rejects(p.recordIntent("r1", claim.epoch, "call-1", intent), is("STATE_UNAVAILABLE"));
  const reservation = { runId: "r1", tenantId: "t", subjectId: "s", kind: "tool" as const, callId: "call-1", estimateMicroUsd: 10, scopes: [] as string[] };
  const missingApproval = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-1", approvalId: "apr-missing", reservation, scopes: [] });
  assert.ok(!missingApproval.ok && missingApproval.code === "APPROVAL_REQUIRED");
  const exhausted = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-1", reservation, scopes: [{ key: "run:r1", ceilingMicroUsd: 5 }] });
  assert.ok(!exhausted.ok && exhausted.code === "BUDGET_EXHAUSTED");
  assert.equal((await p.getCall("call-1"))?.state, "prepared");
  const auth = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-1", reservation, scopes: [{ key: "run:r1", ceilingMicroUsd: 100 }] });
  assert.equal(auth.ok, true);
  const reservationId = (auth as { reservationId: string }).reservationId;
  assert.equal((await p.getCall("call-1"))?.state, "ready");
  assert.equal((await p.getCall("call-1"))?.reservationId, reservationId);
  await p.recordIntent("r1", claim.epoch, "call-1", intent);
  assert.equal((await p.getCall("call-1"))?.state, "intent_committed");
  const result: ToolResult = { callId: "call-1", toolRef: "tool", status: "succeeded", effect: "none", output: { ok: true }, meta: { attempts: 1, durationMs: 3, bytes: 11 } };
  const commit = {
    runId: "r1",
    epoch: claim.epoch,
    callId: "call-1",
    result,
    state: "succeeded" as const,
    reservation: { id: reservationId, actualMicroUsd: 4, state: "settled" as const },
    events: [event("r1", "tool_result")],
    audit: [{ id: "aud-1", at: now, tenantId: "t", runId: "r1", callId: "call-1", type: "tool_result", data: {} }],
    attempt: { attemptId: "att-1", at: now, durationMs: 3, outcome: "succeeded" },
  };
  await assert.rejects(p.commitResult({ ...commit, epoch: claim.epoch + 1 }), is("OWNERSHIP_LOST"));
  await p.commitResult(commit);
  const committed = await p.getCall("call-1");
  assert.equal(committed?.state, "succeeded");
  assert.deepEqual(committed?.result, result);
  assert.equal(committed?.attempts.length, 1);
  assert.equal((await p.getReservation(reservationId))?.state, "settled");
  assert.deepEqual(await p.scopeUsage("run:r1"), { heldMicroUsd: 0, settledMicroUsd: 4 });
  assert.equal((await p.readAudit({ runId: "r1" })).length, 1);
  assert.equal((await p.readAudit({ tenantId: "t", type: "other" })).length, 0);
  await p.recordLateObservation("call-1", { seen: true }, "webhook");
  assert.equal((await p.getCall("call-1"))?.lateObservations?.[0]?.actor, "webhook");
  assert.equal((await p.updateCall("r1", claim.epoch, "call-2", { state: "waiting_approval" })).state, "waiting_approval");
  await assert.rejects(p.updateCall("r1", claim.epoch, "call-9", {}), is("NOT_FOUND"));

  // Approvals: pending -> decided once, with the wake-up; consume clears the run's pending list.
  await p.createApproval(approval("apr-1", "r1", ["call-2"]));
  assert.deepEqual((await p.getRun("r1"))?.pending.approvals, ["apr-1"]);
  const pendingUse = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-2", approvalId: "apr-1", reservation: { ...reservation, callId: "call-2" }, scopes: [] });
  assert.ok(!pendingUse.ok && pendingUse.code === "APPROVAL_REQUIRED");
  await p.decideApproval({ id: "apr-1", actor: ACTOR, decision: "deny", comment: "no", now });
  const deniedUse = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-2", approvalId: "apr-1", reservation: { ...reservation, callId: "call-2" }, scopes: [] });
  assert.ok(!deniedUse.ok && deniedUse.code === "APPROVAL_DENIED");
  assert.equal((await p.getRun("r1"))?.wakeup?.reason, "approval_deny");
  assert.equal((await p.getApproval("apr-1"))?.decision?.comment, "no");
  const consumed = await p.consumeApproval("apr-1", "r1", claim.epoch);
  assert.equal(consumed.status, "denied"); // only approved approvals become consumed
  assert.deepEqual((await p.getRun("r1"))?.pending.approvals, []);
  assert.deepEqual((await p.listApprovals({ runId: "r1", status: ["denied"] })).map((a) => a.id), ["apr-1"]);
  assert.deepEqual(await p.listApprovals({ tenantId: "t", status: ["pending"] }), []);
  await p.createApproval(approval("apr-2", "r1", ["call-2"]));
  await p.decideApproval({ id: "apr-2", actor: ACTOR, decision: "approve", now });
  const approvedUse = await p.authorizeDispatch({ runId: "r1", epoch: claim.epoch, callId: "call-2", approvalId: "apr-2", reservation: { ...reservation, callId: "call-2" }, scopes: [] });
  assert.equal(approvedUse.ok, true);
  assert.equal((await p.consumeApproval("apr-2", "r1", claim.epoch)).status, "consumed");

  // Input requests.
  await p.createInputRequest({ requestId: "q-1", tenantId: "t", runId: "r1", callId: "call-2", question: "Which?", responseSchema: {}, recipientScope: { tenantId: "t", subjectId: "s" }, expiresAt: future(), status: "pending", createdAt: now });
  assert.deepEqual((await p.getRun("r1"))?.pending.inputs, ["q-1"]);
  assert.equal((await p.answerInput({ id: "q-1", actor: ACTOR, value: "A", now })).changed, true);
  assert.equal((await p.answerInput({ id: "q-1", actor: ACTOR, value: "A", now })).changed, false);
  await assert.rejects(p.answerInput({ id: "q-1", actor: ACTOR, value: "B", now }), is("VERSION_CONFLICT"));
  assert.equal((await p.getRun("r1"))?.wakeup?.reason, "input_answered");
  assert.deepEqual((await p.getRun("r1"))?.pending.inputs, []);
  assert.deepEqual((await p.listInputRequests({ tenantId: "t", status: ["answered"] })).map((r) => r.requestId), ["q-1"]);

  // Conversation active-run compare-and-set.
  assert.equal(await p.setActiveRun("c1", "r1"), true);
  assert.equal(await p.setActiveRun("c1", "r2"), false);
  assert.equal(await p.setActiveRun("c1", "r1"), true); // same run: no-op success
  assert.equal(await p.setActiveRun("c1", null, "r2"), false); // wrong expectation
  await p.updateRun("r1", claim.epoch, { state: "completed" });
  assert.equal(await p.setActiveRun("c1", "r2"), true); // a finished run releases the conversation
  assert.equal(await p.setActiveRun("c1", null, "r2"), true);
  assert.equal((await p.getConversation("c1"))?.activeRunId, undefined);
  assert.equal(await p.setActiveRun("missing", "r1"), false);

  // Messages: index order, expiry, limit keeps the newest, before excludes later indices.
  await p.appendMessage({ conversationId: "c1", tenantId: "t", role: "assistant", content: "one", createdAt: now, expiresAt: future() });
  await p.appendMessage({ conversationId: "c1", tenantId: "t", role: "assistant", content: "expired", createdAt: now, expiresAt: "2000-01-01T00:00:00.000Z" });
  await p.appendMessage({ conversationId: "c1", tenantId: "t", role: "assistant", content: "three", createdAt: now, expiresAt: future() });
  assert.deepEqual((await p.listMessages("c1", {})).map((m) => m.index), [0, 1, 3]);
  assert.deepEqual((await p.listMessages("c1", { includeExpired: true })).map((m) => m.index), [0, 1, 2, 3]);
  assert.deepEqual((await p.listMessages("c1", { limit: 2 })).map((m) => m.index), [1, 3]);
  assert.deepEqual((await p.listMessages("c1", { before: 3, limit: 1 })).map((m) => m.index), [1]);
  assert.equal((await p.getConversation("c1"))?.messageCount, 4);
  assert.deepEqual(await p.deleteConversation("c1"), { messages: 4 });
  assert.ok((await p.getConversation("c1"))?.deletedAt);
  assert.deepEqual(await p.listMessages("c1", { includeExpired: true }), []);

  // Run listing and cancellation.
  assert.deepEqual((await p.listRuns({ tenantId: "t", state: ["completed"] })).map((r) => r.runId), ["r1"]);
  assert.deepEqual((await p.listRuns({ conversationId: "c1" })).map((r) => r.runId), ["r1"]);
  assert.deepEqual(await p.listRuns({ conversationId: "nope" }), []);
  await p.requestCancel("r1", "user");
  assert.equal((await p.getRun("r1"))?.cancelRequested?.reason, "user");
  await assert.rejects(p.requestCancel("nope"), is("NOT_FOUND"));

  // Event retention (2): seq 1 exists from commitResult; three more give 2..4, of which 3 and 4 are retained (§19.2).
  await p.appendEvents("r1", null, [event("r1", "x"), event("r1", "y"), event("r1", "z")]);
  const tail = await p.readEvents("r1", 0);
  assert.equal(tail.gap, true);
  assert.deepEqual(tail.events.map((e) => e.seq), [3, 4]);
  assert.equal(tail.lastSeq, 4);
  assert.equal((await p.readEvents("r1", 2)).gap, false);
  assert.equal((await p.readEvents("r1", 2, 1)).events.length, 1);
  await assert.rejects(p.readEvents("nope", 0), is("NOT_FOUND"));

  // Governance sub-stores, model attempts, context explanations.
  const lock = { digest: "sha256:lock", approver: "ops", decidedAt: now, suite: "s1" };
  assert.equal((await p.lockApprovals.put(lock)).changed, true);
  assert.equal((await p.lockApprovals.put({ ...lock, approver: "someone-else" })).changed, false);
  assert.equal((await p.lockApprovals.get("sha256:lock"))?.approver, "ops");
  assert.equal((await p.lockApprovals.latest("s1"))?.digest, "sha256:lock");
  assert.equal((await p.lockApprovals.latest())?.digest, "sha256:lock");
  assert.equal(await p.lockApprovals.latest("s2"), null);
  const report = { id: "rep-1", suite: "s1", datasetVersion: "1", candidateDigest: "sha256:cand", modelTargets: [], mode: "replay" as const, passRate: 1, verifiedSuccessRate: 1, cases: { inline: [] as never[] }, createdAt: now, expiresAt: future() };
  await p.evalReports.put(report);
  await p.evalReports.put({ ...report, passRate: 0.5 });
  assert.equal((await p.evalReports.get("rep-1"))?.passRate, 0.5);
  assert.equal((await p.evalReports.list({ suite: "s1", candidateDigest: "sha256:cand" })).length, 1);
  assert.equal((await p.evalReports.list({ suite: "zzz" })).length, 0);
  const attempt: ModelAttemptRecord = { attemptId: "att-1", modelBindingId: "m", model: "fake", startedAt: now, durationMs: 1, status: "succeeded", compiledDigest: "sha256:req" };
  await p.recordModelAttempt("r1", attempt);
  assert.deepEqual(await p.listModelAttempts("r1"), [attempt]);
  await p.saveContextExplanation({ contextId: "ctx-1", runId: "r1", agentId: "a", tenantId: "t", createdAt: now } as ContextExplanation);
  assert.equal((await p.getContextExplanation("ctx-1"))?.runId, "r1");
  assert.equal(await p.getContextExplanation("ctx-9"), null);
  await p.release(claim);
  assert.equal(await p.currentOwner("c1"), null);
  await p.close();
});

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("namespace heartbeat refreshes on a timer, reports a takeover through health(), re-takes a vacated namespace, and re-inits after close", async () => {
  const path = tmpPath();
  const p = sqlitePersistence({ path, leaseHeartbeatMs: 10 });
  await p.init({ namespace: "hb", ownerId: "me" });
  const raw = new DatabaseSync(path);
  const row = (): { owner_id: string; pid: number; heartbeat_at: number } | undefined =>
    raw.prepare("SELECT owner_id, pid, heartbeat_at FROM owners WHERE namespace = 'hb'").get() as { owner_id: string; pid: number; heartbeat_at: number } | undefined;
  const initial = row();
  assert.equal(initial?.owner_id, "me");
  assert.equal(initial?.pid, process.pid);
  await waitFor(() => (row()?.heartbeat_at ?? 0) > (initial?.heartbeat_at ?? 0));
  // A live intruder holds the row: the heartbeat notices and health() reports the loss without fighting for it.
  raw.prepare("UPDATE owners SET owner_id = 'intruder', pid = ?, heartbeat_at = ? WHERE namespace = 'hb'").run(process.pid, Date.now());
  await waitFor(async () => !(await p.health()).ok);
  assert.match((await p.health()).detail ?? "", /taken over/);
  assert.equal(row()?.owner_id, "intruder");
  // The intruder leaves: the namespace is re-taken and health recovers.
  raw.prepare("DELETE FROM owners WHERE namespace = 'hb'").run();
  await waitFor(async () => (await p.health()).ok);
  assert.equal(row()?.owner_id, "me");
  await p.close();
  assert.equal(row(), undefined); // close() deletes our row
  await p.init({ namespace: "hb", ownerId: "me" });
  assert.equal((await p.health()).ok, true);
  assert.equal(row()?.owner_id, "me");
  await p.close();
  raw.close();
});

test("SqliteDatabase.tx: nested savepoints roll back only the inner work; an outer throw rolls back everything", async () => {
  const { SqliteDatabase } = await import("./db.js");
  const db = new SqliteDatabase(":memory:");
  await assert.rejects(async () => db.one("SELECT 1"), is("STATE_UNAVAILABLE"));
  db.open();
  db.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
  const rows = (): number[] => db.all<{ n: number }>("SELECT n FROM t ORDER BY n").map((r) => r.n);
  db.tx(() => {
    db.run("INSERT INTO t (n) VALUES (1)");
    assert.throws(
      () =>
        db.tx(() => {
          db.run("INSERT INTO t (n) VALUES (2)");
          throw new Error("inner");
        }),
      /inner/,
    );
    db.run("INSERT INTO t (n) VALUES (3)");
    assert.equal(db.tx(() => db.tx(() => 42)), 42);
  });
  assert.deepEqual(rows(), [1, 3]);
  assert.throws(
    () =>
      db.tx(() => {
        db.run("INSERT INTO t (n) VALUES (4)");
        db.tx(() => db.run("INSERT INTO t (n) VALUES (5)"));
        throw new Error("outer");
      }),
    /outer/,
  );
  assert.deepEqual(rows(), [1, 3]);
  db.tx(() => db.run("INSERT INTO t (n) VALUES (6)")); // the connection is still usable after a rollback
  assert.deepEqual(rows(), [1, 3, 6]);
  db.close();
  db.close(); // idempotent
});
