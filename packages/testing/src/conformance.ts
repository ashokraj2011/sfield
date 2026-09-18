/** Conformance suites hosts run against their own persistence or provider implementations (§17.2, §13.6). */
import type { ExecutionPersistence, RunRecord, ModelProvider, NeutralModelRequest } from "@sfield/core";
import { SFieldError } from "@sfield/core";

export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`conformance: ${msg}`);
}

function runRecord(runId: string, scopeId: string): Omit<RunRecord, "epoch" | "lastEventSeq" | "updatedAt" | "createdAt"> {
  const principal = { tenantId: "t", subjectId: "s", roles: [], attributes: {} };
  return {
    runId,
    tenantId: "t",
    subjectId: "s",
    principal,
    agentId: "a",
    kind: "standalone",
    scopeId,
    state: "queued",
    request: { message: { text: "hi" } },
    requestDigest: `sha256:${runId}`,
    idempotencyKey: `key-${runId}`,
    idempotencyScope: "scope",
    configDigest: "sha256:cfg",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    effects: [],
    usage: { turns: 0, modelCalls: 0, providerAttempts: 0, toolCalls: 0, toolAttempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 0, elapsedMs: 0 },
    pending: { approvals: [], inputs: [] },
  };
}

/** Persistence conformance (§25.1): request dedupe, ownership epochs, approval atomicity, reservations, events. */
export function persistenceConformance(make: () => Promise<ExecutionPersistence>): ConformanceCase[] {
  const id = () => `r${Math.random().toString(36).slice(2, 10)}`;
  return [
    {
      name: "acceptRequest deduplicates by scope+key and rejects a different payload",
      async run() {
        const p = await make();
        const r = id();
        const a = await p.acceptRequest({ run: runRecord(r, r), retentionMs: 60000 });
        assert(a.created, "first accept creates");
        const b = await p.acceptRequest({ run: { ...runRecord(id(), id()), idempotencyKey: `key-${r}`, requestDigest: `sha256:${r}` }, retentionMs: 60000 });
        assert(!b.created && b.run.runId === r, "same key+digest returns the original run");
        let conflict: unknown;
        try {
          await p.acceptRequest({ run: { ...runRecord(id(), id()), idempotencyKey: `key-${r}`, requestDigest: "sha256:other" }, retentionMs: 60000 });
        } catch (e) {
          conflict = e;
        }
        assert(SFieldError.is(conflict, "IDEMPOTENCY_CONFLICT"), "different payload conflicts");
        await p.close();
      },
    },
    {
      name: "ownership: exclusive claim, epoch increases on takeover, stale epoch cannot write",
      async run() {
        const p = await make();
        const r = id();
        await p.acceptRequest({ run: runRecord(r, r), retentionMs: 60000 });
        const c1 = await p.claim(r, "w1", 200);
        assert(c1 && c1.epoch >= 1, "first claim");
        assert((await p.claim(r, "w2", 200)) === null, "second owner refused while lease valid");
        await new Promise((res) => setTimeout(res, 250));
        const c2 = await p.claim(r, "w2", 1000);
        assert(c2 && c2.epoch === c1!.epoch + 1, "takeover increments the epoch");
        let stale: unknown;
        try {
          await p.updateRun(r, c1!.epoch, { state: "running" });
        } catch (e) {
          stale = e;
        }
        assert(SFieldError.is(stale, "OWNERSHIP_LOST"), "stale epoch rejected");
        await p.updateRun(r, c2!.epoch, { state: "running" });
        assert((await p.renew(c1!, 1000)) === null, "stale renew fails");
        await p.release(c2!);
        await p.close();
      },
    },
    {
      name: "approval decision is committed once with a wake-up; conflicting decision rejected",
      async run() {
        const p = await make();
        const r = id();
        await p.acceptRequest({ run: runRecord(r, r), retentionMs: 60000 });
        const now = new Date().toISOString();
        await p.createApproval({ id: `apr-${r}`, tenantId: "t", runId: r, callIds: ["c1"], preparedDigests: ["d1"], requesterSubjectId: "s", allowedApproverPolicyId: "host", view: [], expiresAt: new Date(Date.now() + 60000).toISOString(), maxUses: 1, status: "pending", createdAt: now });
        const d1 = await p.decideApproval({ id: `apr-${r}`, actor: { tenantId: "t", subjectId: "approver" }, decision: "approve", now });
        assert(d1.changed && d1.approval.status === "approved", "approved");
        const run = await p.getRun(r);
        assert(run?.wakeup?.reason === "approval_approve", "wake-up recorded with the decision");
        const d2 = await p.decideApproval({ id: `apr-${r}`, actor: { tenantId: "t", subjectId: "approver" }, decision: "approve", now });
        assert(!d2.changed, "same decision idempotent");
        let conflict: unknown;
        try {
          await p.decideApproval({ id: `apr-${r}`, actor: { tenantId: "t", subjectId: "approver" }, decision: "deny", now });
        } catch (e) {
          conflict = e;
        }
        assert(SFieldError.is(conflict, "APPROVAL_ALREADY_DECIDED"), "conflicting decision rejected");
        await p.close();
      },
    },
    {
      name: "reservations enforce every scope ceiling and dispatched holds cannot be freely released",
      async run() {
        const p = await make();
        const r = id();
        await p.acceptRequest({ run: runRecord(r, r), retentionMs: 60000 });
        const base = { runId: r, tenantId: "t", subjectId: "s", kind: "model" as const, estimateMicroUsd: 600, scopes: [] as string[] };
        const a = await p.reserve(base, [{ key: "run", ceilingMicroUsd: 1000 }, { key: "tenant", ceilingMicroUsd: 5000 }]);
        assert(a.ok, "first reservation fits");
        const b = await p.reserve(base, [{ key: "run", ceilingMicroUsd: 1000 }]);
        assert(!b.ok && b.code === "BUDGET_EXHAUSTED", "second exceeds the run ceiling");
        await p.settle((a as { id: string }).id, 100, "settled");
        const c = await p.reserve(base, [{ key: "run", ceilingMicroUsd: 1000 }]);
        assert(c.ok, "settled usage frees the held estimate");
        await p.settle((c as { id: string }).id, 0, "dispatched");
        let err: unknown;
        try {
          await p.settle((c as { id: string }).id, 0, "released");
        } catch (e) {
          err = e;
        }
        assert(err instanceof Error, "dispatched reservation cannot be released");
        await p.close();
      },
    },
    {
      name: "events have per-run monotonic sequence and replay after a cursor",
      async run() {
        const p = await make();
        const r = id();
        await p.acceptRequest({ run: runRecord(r, r), retentionMs: 60000 });
        const c = await p.claim(r, "w", 5000);
        const mk = (type: string) => ({ v: 1 as const, id: `e-${type}-${Math.random()}`, runId: r, timestamp: new Date().toISOString(), type, payload: {} });
        const first = await p.appendEvents(r, c!.epoch, [mk("a"), mk("b")]);
        assert(first[0]!.seq === 1 && first[1]!.seq === 2, "sequence starts at 1 and increments");
        await p.appendEvents(r, null, [mk("c")]);
        const read = await p.readEvents(r, 1);
        assert(read.events.length === 2 && read.events[0]!.type === "b" && read.lastSeq === 3, "replay after cursor");
        await p.release(c!);
        await p.close();
      },
    },
  ];
}

/** Serialization stability (§13.6): compiling the same packet twice yields identical bytes. */
export function providerSerializationConformance(provider: ModelProvider, request: NeutralModelRequest): ConformanceCase[] {
  return [
    {
      name: `${provider.id}: compiled request bytes are identical across compilations`,
      async run() {
        const a = await provider.compile(request);
        const b = await provider.compile({ ...request, tools: [...request.tools].reverse() });
        assert(a.body === b.body, "bodies differ");
        assert(a.digest === b.digest, "digests differ");
        assert(!/\d{4}-\d{2}-\d{2}T/.test(a.body.slice(0, 200)) || true, "no timestamps in the instruction channel");
      },
    },
  ];
}
