/** In-memory ExecutionPersistence (§17.1 `ephemeral`): one process, restart loses state. Every method is atomic (no awaits inside). */
import type { Actor, JsonObject, JsonValue } from "../types/common.js";
import type { ContextExplanation } from "../types/context.js";
import type { ModelAttemptRecord } from "../types/model.js";
import type {
  AcceptRequestInput,
  AcceptRequestResult,
  ApprovalRecord,
  ArtifactStore,
  AuditRecord,
  BudgetScopeRequest,
  CallRecord,
  CommitResultInput,
  ConversationRecord,
  EvalReportRecord,
  ExecutionPersistence,
  InputRequestRecord,
  LockApprovalRecord,
  MessageRecord,
  OwnershipClaim,
  ReservationRecord,
  ReservationState,
  RunRecord,
} from "../types/persistence.js";
import type { Checkpoint, RunEvent, RunState } from "../types/runtime.js";
import type { MemoryRepository } from "../types/memory.js";
import { SFieldError } from "../errors.js";
import { deepClone } from "../util/freeze.js";
import { newId, nowIso } from "../util/digest.js";
import { InMemoryArtifactStore } from "./artifacts-memory.js";
import { InMemoryMemoryRepository } from "../memory/repository-memory.js";

export interface EphemeralOptions {
  eventRetention?: number;
  memory?: MemoryRepository;
  artifacts?: ArtifactStore;
}

export class EphemeralPersistence implements ExecutionPersistence {
  readonly mode = "ephemeral" as const;
  readonly memory: MemoryRepository;
  readonly artifacts: ArtifactStore;
  private readonly eventRetention: number;

  private readonly runs = new Map<string, RunRecord>();
  private readonly idempotency = new Map<string, { runId: string; digest: string; expiresAt: string }>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly runCalls = new Map<string, string[]>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly inputs = new Map<string, InputRequestRecord>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly events = new Map<string, { list: RunEvent[]; oldestSeq: number }>();
  private readonly audit: AuditRecord[] = [];
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly attempts = new Map<string, ModelAttemptRecord[]>();
  private readonly explanations = new Map<string, ContextExplanation>();
  private readonly ownership = new Map<string, OwnershipClaim>();
  private readonly epochs = new Map<string, number>();
  private readonly lockApprovalMap = new Map<string, LockApprovalRecord>();
  private readonly evalReportMap = new Map<string, EvalReportRecord>();
  private closed = false;

  constructor(opts: EphemeralOptions = {}) {
    this.eventRetention = opts.eventRetention ?? 10000;
    this.memory = opts.memory ?? new InMemoryMemoryRepository();
    this.artifacts = opts.artifacts ?? new InMemoryArtifactStore();
  }

  async init(_ctx?: { namespace: string; ownerId: string }): Promise<void> {
    this.closed = false;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: !this.closed, detail: this.closed ? "closed" : "in-memory" };
  }

  // ---- runs & requests
  async acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult> {
    const key = `${input.run.idempotencyScope}::${input.run.idempotencyKey}`;
    const now = nowIso();
    const existing = this.idempotency.get(key);
    if (existing && existing.expiresAt > now) {
      const run = this.runs.get(existing.runId);
      if (run) {
        if (existing.digest !== input.run.requestDigest) {
          throw new SFieldError("IDEMPOTENCY_CONFLICT", `request key ${input.run.idempotencyKey} was used with a different payload`, { suggestion: "Reuse the original payload or choose a new request key" });
        }
        return { run: deepClone(run), created: false };
      }
    }
    const run: RunRecord = { ...deepClone(input.run), epoch: 0, lastEventSeq: 0, createdAt: input.run.createdAt ?? now, updatedAt: now, wakeup: { at: now, reason: "accepted" } } as RunRecord;
    this.runs.set(run.runId, run);
    this.idempotency.set(key, { runId: run.runId, digest: run.requestDigest, expiresAt: new Date(Date.parse(now) + input.retentionMs).toISOString() });
    if (input.message) this.appendMessageSync(input.message);
    return { run: deepClone(run), created: true };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    return r ? deepClone(r) : null;
  }

  async listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]> {
    const out = [...this.runs.values()].filter(
      (r) => (!filter.tenantId || r.tenantId === filter.tenantId) && (!filter.conversationId || r.conversationId === filter.conversationId) && (!filter.state || filter.state.includes(r.state)),
    );
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return deepClone(out.slice(0, filter.limit ?? 100));
  }

  async updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    Object.assign(run, deepClone(patch), { updatedAt: nowIso(), epoch });
    return deepClone(run);
  }

  async listWakeups(): Promise<RunRecord[]> {
    return deepClone([...this.runs.values()].filter((r) => !!r.wakeup));
  }

  async requestCancel(runId: string, reason?: string): Promise<void> {
    const run = this.mustRun(runId);
    if (!run.cancelRequested) run.cancelRequested = reason ? { at: nowIso(), reason } : { at: nowIso() };
    run.updatedAt = nowIso();
  }

  // ---- ownership
  async claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null> {
    const now = Date.now();
    const current = this.ownership.get(scopeId);
    if (current && current.ownerId !== ownerId && Date.parse(current.expiresAt) > now) return null;
    let epoch: number;
    if (current && current.ownerId === ownerId && Date.parse(current.expiresAt) > now) epoch = current.epoch;
    else {
      epoch = (this.epochs.get(scopeId) ?? 0) + 1;
      this.epochs.set(scopeId, epoch);
    }
    const claim: OwnershipClaim = { scopeId, ownerId, epoch, expiresAt: new Date(now + leaseMs).toISOString() };
    this.ownership.set(scopeId, claim);
    return { ...claim };
  }

  async renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null> {
    const current = this.ownership.get(claim.scopeId);
    if (!current || current.ownerId !== claim.ownerId || current.epoch !== claim.epoch || Date.parse(current.expiresAt) <= Date.now()) return null;
    current.expiresAt = new Date(Date.now() + leaseMs).toISOString();
    return { ...current };
  }

  async release(claim: OwnershipClaim): Promise<void> {
    const current = this.ownership.get(claim.scopeId);
    if (current && current.ownerId === claim.ownerId && current.epoch === claim.epoch) this.ownership.delete(claim.scopeId);
  }

  async currentOwner(scopeId: string): Promise<OwnershipClaim | null> {
    const c = this.ownership.get(scopeId);
    return c && Date.parse(c.expiresAt) > Date.now() ? { ...c } : null;
  }

  private mustRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new SFieldError("NOT_FOUND", `run ${runId} not found`);
    return run;
  }

  private assertOwner(run: RunRecord, epoch: number): void {
    const claim = this.ownership.get(run.scopeId);
    if (!claim || claim.epoch !== epoch || Date.parse(claim.expiresAt) <= Date.now()) {
      throw new SFieldError("OWNERSHIP_LOST", `epoch ${epoch} no longer owns ${run.scopeId}`, { runId: run.runId });
    }
  }

  // ---- conversations
  async createConversation(rec: ConversationRecord): Promise<ConversationRecord> {
    if (!this.conversations.has(rec.id)) this.conversations.set(rec.id, deepClone(rec));
    return deepClone(this.conversations.get(rec.id)!);
  }
  async getConversation(id: string): Promise<ConversationRecord | null> {
    const c = this.conversations.get(id);
    return c ? deepClone(c) : null;
  }
  async setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean> {
    const c = this.conversations.get(conversationId);
    if (!c) return false;
    const current = c.activeRunId ?? null;
    if (runId !== null && current !== null && current !== runId && current !== (expectedActive ?? null)) {
      const activeRun = this.runs.get(current);
      // A finished run releases the conversation even if the release was lost.
      if (activeRun && isTerminalState(activeRun.state)) {
        c.activeRunId = runId;
        return true;
      }
      return false;
    }
    if (runId === null && expectedActive !== undefined && expectedActive !== null && current !== expectedActive) return false;
    if (runId === null) delete c.activeRunId;
    else c.activeRunId = runId;
    c.updatedAt = nowIso();
    return true;
  }
  private appendMessageSync(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): MessageRecord {
    const list = this.messages.get(msg.conversationId) ?? [];
    const rec: MessageRecord = { ...deepClone(msg), id: msg.id ?? newId("msg"), index: list.length } as MessageRecord;
    list.push(rec);
    this.messages.set(msg.conversationId, list);
    const c = this.conversations.get(msg.conversationId);
    if (c) {
      c.messageCount = list.length;
      c.updatedAt = nowIso();
    }
    return deepClone(rec);
  }
  async appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord> {
    return this.appendMessageSync(msg);
  }
  async listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]> {
    const now = nowIso();
    let list = this.messages.get(conversationId) ?? [];
    if (!opts.includeExpired) list = list.filter((m) => m.expiresAt > now);
    if (opts.before !== undefined) list = list.filter((m) => m.index < opts.before!);
    if (opts.limit !== undefined) list = list.slice(-opts.limit);
    return deepClone(list);
  }
  async deleteConversation(id: string): Promise<{ messages: number }> {
    const n = this.messages.get(id)?.length ?? 0;
    this.messages.delete(id);
    const c = this.conversations.get(id);
    if (c) {
      c.deletedAt = nowIso();
      c.messageCount = 0;
    }
    return { messages: n };
  }

  // ---- calls
  async prepareBatch(runId: string, epoch: number, calls: CallRecord[]): Promise<void> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    const ids = this.runCalls.get(runId) ?? [];
    for (const c of calls) {
      this.calls.set(c.callId, deepClone(c));
      if (!ids.includes(c.callId)) ids.push(c.callId);
    }
    this.runCalls.set(runId, ids);
  }
  async getCall(callId: string): Promise<CallRecord | null> {
    const c = this.calls.get(callId);
    return c ? deepClone(c) : null;
  }
  async listCalls(runId: string): Promise<CallRecord[]> {
    return deepClone((this.runCalls.get(runId) ?? []).map((id) => this.calls.get(id)!).filter(Boolean));
  }
  async updateCall(runId: string, epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    const call = this.calls.get(callId);
    if (!call || call.runId !== runId) throw new SFieldError("NOT_FOUND", `call ${callId} not found in run ${runId}`);
    Object.assign(call, deepClone(patch), { updatedAt: nowIso() });
    return deepClone(call);
  }
  async authorizeDispatch(input: {
    runId: string;
    epoch: number;
    callId: string;
    approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }> {
    const run = this.mustRun(input.runId);
    this.assertOwner(run, input.epoch);
    const call = this.calls.get(input.callId);
    if (!call || call.runId !== input.runId) return { ok: false, code: "STATE_UNAVAILABLE", reason: "call not found" };
    if (call.state !== "prepared" && call.state !== "ready" && call.state !== "waiting_approval") return { ok: false, code: "STATE_UNAVAILABLE", reason: `call is ${call.state}` };
    if (input.approvalId) {
      const a = this.approvals.get(input.approvalId);
      if (!a || a.status !== "approved") return { ok: false, code: a?.status === "denied" ? "APPROVAL_DENIED" : "APPROVAL_REQUIRED", reason: `approval ${a?.status ?? "missing"}` };
      if (a.expiresAt <= nowIso()) return { ok: false, code: "APPROVAL_EXPIRED", reason: "approval expired" };
      if (!a.callIds.includes(input.callId)) return { ok: false, code: "APPROVAL_INVALID", reason: "call not covered" };
    }
    const reserved = this.reserveSync(input.reservation, input.scopes);
    if (!reserved.ok) return reserved;
    call.state = "ready";
    call.reservationId = reserved.id;
    call.updatedAt = nowIso();
    return { ok: true, reservationId: reserved.id };
  }
  async recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    const call = this.calls.get(callId);
    if (!call) throw new SFieldError("NOT_FOUND", `call ${callId} not found`);
    if (call.state !== "ready") throw new SFieldError("STATE_UNAVAILABLE", `call ${callId} is ${call.state}, cannot record intent`);
    call.intent = deepClone(intent);
    call.state = "intent_committed";
    call.updatedAt = nowIso();
  }
  async commitResult(input: CommitResultInput): Promise<void> {
    const run = this.mustRun(input.runId);
    this.assertOwner(run, input.epoch);
    const call = this.calls.get(input.callId);
    if (!call || call.runId !== input.runId) throw new SFieldError("NOT_FOUND", `call ${input.callId} not found`);
    call.result = deepClone(input.result);
    call.state = input.state;
    if (input.attempt) call.attempts.push(deepClone(input.attempt));
    call.updatedAt = nowIso();
    if (input.reservation) {
      const r = this.reservations.get(input.reservation.id);
      if (r) {
        r.actualMicroUsd = input.reservation.actualMicroUsd;
        r.state = input.reservation.state;
        r.updatedAt = nowIso();
      }
    }
    this.appendEventsSync(run, input.events);
    if (input.audit) this.audit.push(...deepClone(input.audit));
  }
  async recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) throw new SFieldError("NOT_FOUND", `call ${callId} not found`);
    call.lateObservations = call.lateObservations ?? [];
    const entry: NonNullable<CallRecord["lateObservations"]>[number] = { at: nowIso(), observation: deepClone(observation) };
    if (actor) entry.actor = actor;
    call.lateObservations.push(entry);
  }

  // ---- approvals
  async createApproval(rec: ApprovalRecord): Promise<ApprovalRecord> {
    this.approvals.set(rec.id, deepClone(rec));
    const run = this.runs.get(rec.runId);
    if (run && !run.pending.approvals.includes(rec.id)) run.pending.approvals.push(rec.id);
    return deepClone(rec);
  }
  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const a = this.approvals.get(id);
    return a ? deepClone(a) : null;
  }
  async listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]> {
    return deepClone([...this.approvals.values()].filter((a) => (!filter.tenantId || a.tenantId === filter.tenantId) && (!filter.runId || a.runId === filter.runId) && (!filter.status || filter.status.includes(a.status))));
  }
  async decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }> {
    const a = this.approvals.get(input.id);
    if (!a) throw new SFieldError("NOT_FOUND", `approval ${input.id} not found`);
    if (a.status !== "pending") {
      if (a.decision && a.decision.decision === input.decision) return { approval: deepClone(a), changed: false };
      throw new SFieldError("APPROVAL_ALREADY_DECIDED", `approval ${a.id} was already ${a.status}`);
    }
    a.status = input.decision === "approve" ? "approved" : "denied";
    a.decision = { actor: { tenantId: input.actor.tenantId, subjectId: input.actor.subjectId }, decision: input.decision, decidedAt: input.now };
    if (input.comment) a.decision.comment = input.comment;
    const run = this.runs.get(a.runId);
    if (run) run.wakeup = { at: input.now, reason: `approval_${input.decision}` };
    return { approval: deepClone(a), changed: true };
  }
  async consumeApproval(id: string, runId: string, epoch: number): Promise<ApprovalRecord> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    const a = this.approvals.get(id);
    if (!a) throw new SFieldError("NOT_FOUND", `approval ${id} not found`);
    if (a.status === "approved") {
      a.status = "consumed";
      a.consumedAt = nowIso();
    }
    run.pending.approvals = run.pending.approvals.filter((x) => x !== id);
    return deepClone(a);
  }

  // ---- inputs
  async createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord> {
    this.inputs.set(rec.requestId, deepClone(rec));
    const run = this.runs.get(rec.runId);
    if (run && !run.pending.inputs.includes(rec.requestId)) run.pending.inputs.push(rec.requestId);
    return deepClone(rec);
  }
  async getInputRequest(id: string): Promise<InputRequestRecord | null> {
    const r = this.inputs.get(id);
    return r ? deepClone(r) : null;
  }
  async listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]> {
    return deepClone([...this.inputs.values()].filter((r) => (!filter.tenantId || r.tenantId === filter.tenantId) && (!filter.runId || r.runId === filter.runId) && (!filter.status || filter.status.includes(r.status))));
  }
  async answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }> {
    const r = this.inputs.get(input.id);
    if (!r) throw new SFieldError("NOT_FOUND", `input request ${input.id} not found`);
    if (r.status !== "pending") {
      if (r.answer && JSON.stringify(r.answer.value) === JSON.stringify(input.value)) return { request: deepClone(r), changed: false };
      throw new SFieldError("VERSION_CONFLICT", `question ${r.requestId} was already answered`);
    }
    r.status = "answered";
    r.answer = { actor: { tenantId: input.actor.tenantId, subjectId: input.actor.subjectId }, value: deepClone(input.value), answeredAt: input.now };
    const run = this.runs.get(r.runId);
    if (run) {
      run.wakeup = { at: input.now, reason: "input_answered" };
      run.pending.inputs = run.pending.inputs.filter((x) => x !== r.requestId);
    }
    return { request: deepClone(r), changed: true };
  }

  // ---- checkpoints & events
  async saveCheckpoint(runId: string, epoch: number, checkpoint: Checkpoint): Promise<void> {
    const run = this.mustRun(runId);
    this.assertOwner(run, epoch);
    this.checkpoints.set(runId, deepClone(checkpoint));
  }
  async getCheckpoint(runId: string): Promise<Checkpoint | null> {
    const c = this.checkpoints.get(runId);
    return c ? deepClone(c) : null;
  }
  private appendEventsSync(run: RunRecord, events: RunEvent[]): RunEvent[] {
    const bucket = this.events.get(run.runId) ?? { list: [], oldestSeq: 1 };
    const out: RunEvent[] = [];
    for (const ev of events) {
      const seq = ++run.lastEventSeq;
      const stored: RunEvent = { ...deepClone(ev), seq };
      bucket.list.push(stored);
      out.push(deepClone(stored));
    }
    while (bucket.list.length > this.eventRetention) {
      bucket.list.shift();
      bucket.oldestSeq = bucket.list[0]?.seq ?? run.lastEventSeq + 1;
    }
    this.events.set(run.runId, bucket);
    return out;
  }
  async appendEvents(runId: string, epoch: number | null, events: RunEvent[]): Promise<RunEvent[]> {
    const run = this.mustRun(runId);
    if (epoch !== null) this.assertOwner(run, epoch);
    return this.appendEventsSync(run, events);
  }
  async readEvents(runId: string, afterSeq: number, limit = 1000): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }> {
    const run = this.mustRun(runId);
    const bucket = this.events.get(runId) ?? { list: [], oldestSeq: 1 };
    const gap = bucket.list.length > 0 && afterSeq + 1 < bucket.oldestSeq;
    const events = bucket.list.filter((e) => (e.seq ?? 0) > afterSeq).slice(0, limit);
    return { events: deepClone(events), gap, lastSeq: run.lastEventSeq };
  }

  // ---- audit
  async appendAudit(records: AuditRecord[]): Promise<void> {
    this.audit.push(...deepClone(records));
  }
  async readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]> {
    const out = this.audit.filter((a) => (!filter.tenantId || a.tenantId === filter.tenantId) && (!filter.runId || a.runId === filter.runId) && (!filter.type || a.type === filter.type));
    return deepClone(out.slice(-(filter.limit ?? 1000)));
  }

  // ---- budgets
  private reserveSync(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): { ok: true; id: string } | { ok: false; code: string; reason: string } {
    for (const scope of scopes) {
      const usage = this.scopeUsageSync(scope.key);
      if (usage.heldMicroUsd + usage.settledMicroUsd + input.estimateMicroUsd > scope.ceilingMicroUsd) {
        return { ok: false, code: "BUDGET_EXHAUSTED", reason: `scope ${scope.key}: ${usage.heldMicroUsd + usage.settledMicroUsd} used + ${input.estimateMicroUsd} estimate exceeds ${scope.ceilingMicroUsd} micro-USD` };
      }
    }
    const now = nowIso();
    const rec: ReservationRecord = { ...deepClone(input), id: newId("rsv"), scopes: scopes.map((s) => s.key), state: "held", createdAt: now, updatedAt: now };
    this.reservations.set(rec.id, rec);
    return { ok: true, id: rec.id };
  }
  async reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<{ ok: true; id: string } | { ok: false; code: string; reason: string }> {
    return this.reserveSync(input, scopes);
  }
  async settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void> {
    const r = this.reservations.get(id);
    if (!r) throw new SFieldError("NOT_FOUND", `reservation ${id} not found`);
    if (r.state === "settled" || r.state === "released") return; // idempotent
    if (state === "released" && r.state !== "held") throw new SFieldError("STATE_UNAVAILABLE", `reservation ${id} was dispatched; it cannot be freely released`);
    r.actualMicroUsd = actualMicroUsd;
    r.state = state;
    r.updatedAt = nowIso();
  }
  async getReservation(id: string): Promise<ReservationRecord | null> {
    const r = this.reservations.get(id);
    return r ? deepClone(r) : null;
  }
  private scopeUsageSync(scopeKey: string): { heldMicroUsd: number; settledMicroUsd: number } {
    let held = 0;
    let settled = 0;
    for (const r of this.reservations.values()) {
      if (!r.scopes.includes(scopeKey)) continue;
      if (r.state === "settled") settled += r.actualMicroUsd ?? 0;
      else if (r.state === "uncertain") held += Math.max(r.estimateMicroUsd, r.actualMicroUsd ?? 0);
      else if (r.state === "held" || r.state === "dispatched") held += r.estimateMicroUsd;
    }
    return { heldMicroUsd: held, settledMicroUsd: settled };
  }
  async scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }> {
    return this.scopeUsageSync(scopeKey);
  }

  // ---- model attempts, explanations
  async recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void> {
    const list = this.attempts.get(runId) ?? [];
    list.push(deepClone(rec));
    this.attempts.set(runId, list);
  }
  async listModelAttempts(runId: string): Promise<ModelAttemptRecord[]> {
    return deepClone(this.attempts.get(runId) ?? []);
  }
  async saveContextExplanation(rec: ContextExplanation): Promise<void> {
    this.explanations.set(rec.contextId, deepClone(rec));
  }
  async getContextExplanation(id: string): Promise<ContextExplanation | null> {
    const e = this.explanations.get(id);
    return e ? deepClone(e) : null;
  }

  // ---- governance
  readonly lockApprovals = {
    get: async (digest: string): Promise<LockApprovalRecord | null> => {
      const r = this.lockApprovalMap.get(digest);
      return r ? deepClone(r) : null;
    },
    put: async (rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }> => {
      const existing = this.lockApprovalMap.get(rec.digest);
      if (existing) return { record: deepClone(existing), changed: false };
      this.lockApprovalMap.set(rec.digest, deepClone(rec));
      return { record: deepClone(rec), changed: true };
    },
    latest: async (suite?: string): Promise<LockApprovalRecord | null> => {
      const all = [...this.lockApprovalMap.values()].filter((r) => !suite || r.suite === suite).sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
      return all[0] ? deepClone(all[0]) : null;
    },
  };
  readonly evalReports = {
    get: async (id: string): Promise<EvalReportRecord | null> => {
      const r = this.evalReportMap.get(id);
      return r ? deepClone(r) : null;
    },
    put: async (rec: EvalReportRecord): Promise<void> => {
      this.evalReportMap.set(rec.id, deepClone(rec));
    },
    list: async (filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]> => {
      return deepClone([...this.evalReportMap.values()].filter((r) => (!filter.suite || r.suite === filter.suite) && (!filter.candidateDigest || r.candidateDigest === filter.candidateDigest)));
    },
  };
}

function isTerminalState(state: RunState): boolean {
  return ["completed", "refused", "filtered", "denied", "expired", "cancelled", "failed", "budget_exhausted", "verification_failed"].includes(state);
}
