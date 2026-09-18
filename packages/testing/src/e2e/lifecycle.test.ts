import { test } from "node:test";
import assert from "node:assert/strict";
import { SFieldError, EphemeralPersistence } from "@sfield/core";
import { baseConfig, createHarness, TEST_PRINCIPAL } from "../harness.js";

const cfg = baseConfig({ agents: { support: { instructions: "Help.", memory: { conversation: true } } } });

test("event replay: `after` cursor skips earlier events; retention loss yields an explicit gap with a snapshot cursor", async () => {
  const h = await createHarness({ config: cfg, script: [{ text: "hello" }], persistence: new EphemeralPersistence({ eventRetention: 3 }) });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "hi" } });
  await run.result();
  const all = [];
  for await (const ev of run.events()) all.push(ev);
  assert.ok(all.some((e) => e.type === "gap"), "old events fell out of retention → gap");
  const lastSeq = Math.max(...all.filter((e) => e.seq !== undefined).map((e) => e.seq!));
  const later = [];
  for await (const ev of run.events({ after: String(lastSeq - 1) })) later.push(ev);
  assert.deepEqual(later.map((e) => e.seq), [lastSeq]);
  assert.equal(later[0]!.type, "run_finished");
  await h.sf.close();
});

test("conversation history, export, and delete are principal-bound and keep audit", async () => {
  const h = await createHarness({ config: cfg, script: [{ text: "first" }, { text: "second" }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  await (await session.send({ message: { text: "one" } })).result();
  await (await session.send({ message: { text: "two" } })).result();
  const history = await h.sf.conversations.history({ id: session.conversationId });
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  // The second turn saw the first exchange as history.
  const second = h.provider.requests[1]!;
  assert.ok(second.messages.length >= 3);
  const ref = await h.sf.conversations.export({ id: session.conversationId });
  assert.equal(ref.mediaType, "application/json");
  const other = { tenantId: "t2", subjectId: "x", roles: [], attributes: {} };
  await assert.rejects(h.sf.conversations.history({ id: session.conversationId, principal: other }), (e: unknown) => SFieldError.is(e, "NOT_FOUND"));
  const deleted = await h.sf.conversations.delete({ id: session.conversationId });
  assert.equal(deleted.messages, 4);
  assert.deepEqual(await h.sf.conversations.history({ id: session.conversationId }).catch((e: SFieldError) => e.code), "NOT_FOUND");
  const audit = await h.sf.audit.read({ type: "conversation_deleted" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.data["auditRetained"], true);
  await h.sf.close();
});

test("close drains an active run within drainMs and health reports closed afterwards", async () => {
  const h = await createHarness({ config: cfg, script: [{ text: "slow answer", delayMs: 300 }] });
  const session = await h.sf.sessions.open({ agent: "support" });
  const run = await session.send({ message: { text: "hi" } });
  await h.sf.close({ drainMs: 5000 });
  const result = await run.result();
  assert.equal(result.state, "completed", "the active run finished during the drain");
  assert.equal((await h.sf.health()).ok, false);
  await assert.rejects(h.sf.sessions.open({ agent: "support" }).then((s) => s.send({ message: { text: "late" } })));
});

test("standalone runs have no conversation memory and are principal-scoped", async () => {
  const h = await createHarness({ config: cfg, script: [{ text: "standalone" }] });
  const run = await h.sf.runs.start({ agent: "support", principal: TEST_PRINCIPAL, request: { message: { text: "q" } } });
  const result = await run.result();
  assert.equal(result.state, "completed");
  const snapshot = await run.snapshot();
  assert.equal(snapshot.conversationId, undefined);
  const other = { tenantId: "t2", subjectId: "y", roles: [], attributes: {} };
  await assert.rejects(h.sf.runs.get({ runId: run.id, principal: other }), (e: unknown) => SFieldError.is(e, "NOT_FOUND"));
  await h.sf.close();
});
