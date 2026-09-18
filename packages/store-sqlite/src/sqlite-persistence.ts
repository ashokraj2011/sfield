/**
 * Durable single-process ExecutionPersistence over `node:sqlite` (§17.1 `durable_single`).
 *
 * Every domain operation is one `BEGIN IMMEDIATE … COMMIT` transaction (§17.2 "required atomic behavior"); ownership
 * uses durable, monotonically increasing per-scope epochs whose counter survives release (§17.3); events carry a per-run
 * monotonic `seq` with bounded retention (§19.2); and exactly one process holds a deployment namespace at a time through
 * the `owners` table. Record semantics mirror the in-memory reference store; every result is a fresh copy.
 */
import type {
  AcceptRequestInput,
  AcceptRequestResult,
  Actor,
  ApprovalRecord,
  AuditRecord,
  BudgetScopeRequest,
  CallRecord,
  Checkpoint,
  CommitResultInput,
  ContextExplanation,
  ConversationRecord,
  EvalReportRecord,
  ExecutionPersistence,
  InputRequestRecord,
  JsonObject,
  JsonValue,
  LockApprovalRecord,
  MessageRecord,
  ModelAttemptRecord,
  OwnershipClaim,
  ReservationRecord,
  ReservationState,
  RunEvent,
  RunRecord,
  RunState,
} from "@sfield/core";
import { SFieldError, newId, nowIso } from "@sfield/core";
import { SqliteDatabase } from "./db.js";
import { ensureSchema } from "./schema.js";
import { SqliteMemoryRepository } from "./sqlite-memory.js";

export interface SqlitePersistenceOptions {
  /** Database file path (parent directories are created) or `":memory:"`. */
  path: string;
  /** Durable events retained per run; older ones are trimmed and readers before the cutoff see `gap` (§19.2). Default 10000. */
  eventRetention?: number;
  /** Interval at which this process refreshes its namespace-owner heartbeat (§17.1). Default 10 s. */
  leaseHeartbeatMs?: number;
}

/** A namespace owner whose heartbeat is older than this is treated as gone when its pid is no longer alive. */
const OWNER_STALE_MS = 30_000;

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["completed", "refused", "filtered", "denied", "expired", "cancelled", "failed", "budget_exhausted", "verification_failed"]);

type BodyRow = { body: string };
type OwnerRow = { owner_id: string; pid: number; heartbeat_at: number };
type OwnershipRow = { scope_id: string; owner_id: string; epoch: number; expires_at: number };
type ReserveDecision = { ok: true; id: string } | { ok: false; code: string; reason: string };
type DispatchDecision = { ok: true; reservationId: string } | { ok: false; code: string; reason: string };

const UPSERT_RUN = `INSERT INTO runs (run_id, tenant_id, conversation_id, scope_id, state, created_at, wakeup_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET tenant_id = excluded.tenant_id, conversation_id = excluded.conversation_id, scope_id = excluded.scope_id,
    state = excluded.state, created_at = excluded.created_at, wakeup_at = excluded.wakeup_at, body = excluded.body`;
const SELECT_OWNERSHIP = "SELECT scope_id, owner_id, epoch, expires_at FROM ownership WHERE scope_id = ?";

export class SqlitePersistence implements ExecutionPersistence {
  readonly mode = "durable_single" as const;
  /** Default memory repository over the same database (§17.5). No default `artifacts`: the preset supplies a filesystem store. */
  readonly memory: SqliteMemoryRepository;

  private readonly db: SqliteDatabase;
  private readonly eventRetention: number;
  private readonly heartbeatMs: number;
  private owner: { namespace: string; ownerId: string } | null = null;
  private ownershipLost = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SqlitePersistenceOptions) {
    this.db = new SqliteDatabase(opts.path);
    this.eventRetention = opts.eventRetention ?? 10000;
    this.heartbeatMs = opts.leaseHeartbeatMs ?? 10_000;
    this.memory = new SqliteMemoryRepository(this.db);
  }

  get path(): string {
    return this.db.path;
  }

  // ---- lifecycle (§17.1): schema, then exclusive ownership of the deployment namespace

  async init(ctx: { namespace: string; ownerId: string }): Promise<void> {
    if (this.owner && (this.owner.namespace !== ctx.namespace || this.owner.ownerId !== ctx.ownerId)) this.releaseNamespace();
    this.db.open();
    try {
      ensureSchema(this.db);
      const holder = this.acquireNamespace(ctx.namespace, ctx.ownerId);
      if (holder) {
        throw new SFieldError("OWNERSHIP_UNAVAILABLE", `deployment namespace ${ctx.namespace} in ${this.db.label} is owned by ${holder.owner_id} (pid ${holder.pid}); durable_single requires exclusive ownership`, {
          suggestion: "Stop the other process, or give this instance its own namespace or database file",
        });
      }
    } catch (err) {
      // Startup fails cleanly: a refused instance holds no file handles.
      this.stopHeartbeat();
      this.owner = null;
      this.db.close();
      throw err;
    }
    this.owner = { namespace: ctx.namespace, ownerId: ctx.ownerId };
    this.ownershipLost = false;
    this.startHeartbeat();
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    this.releaseNamespace();
    this.db.close();
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.db.isOpen) return { ok: false, detail: "closed" };
    try {
      this.db.one("SELECT 1 AS ok");
    } catch (err) {
      return { ok: false, detail: SFieldError.from(err).message };
    }
    if (this.ownershipLost) return { ok: false, detail: `namespace ${this.owner?.namespace ?? "?"} ownership was taken over by another process` };
    return { ok: true, detail: `sqlite ${this.db.label}` };
  }

  /** Takes the namespace unless a different owner is alive (fresh heartbeat and live pid); returns that holder otherwise. */
  private acquireNamespace(namespace: string, ownerId: string): OwnerRow | null {
    return this.db.tx(() => {
      const now = Date.now();
      const current = this.db.one<OwnerRow>("SELECT owner_id, pid, heartbeat_at FROM owners WHERE namespace = ?", namespace);
      if (current && current.owner_id !== ownerId && now - Number(current.heartbeat_at) < OWNER_STALE_MS && pidAlive(Number(current.pid))) return current;
      this.db.run(
        "INSERT INTO owners (namespace, owner_id, pid, heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at",
        namespace,
        ownerId,
        process.pid,
        now,
      );
      return null;
    });
  }

  private releaseNamespace(): void {
    const owner = this.owner;
    this.owner = null;
    if (!owner || !this.db.isOpen) return;
    try {
      this.db.run("DELETE FROM owners WHERE namespace = ? AND owner_id = ?", owner.namespace, owner.ownerId);
    } catch {
      // Best effort: a row left behind is taken over once its heartbeat is stale.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    timer.unref();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private heartbeat(): void {
    const owner = this.owner;
    if (!owner || !this.db.isOpen) return;
    try {
      const { changes } = this.db.run("UPDATE owners SET heartbeat_at = ? WHERE namespace = ? AND owner_id = ?", Date.now(), owner.namespace, owner.ownerId);
      if (changes === 1) {
        this.ownershipLost = false;
        return;
      }
      // Our row is gone or belongs to someone else: re-take it unless a live owner holds it, and report the loss through health().
      this.ownershipLost = this.acquireNamespace(owner.namespace, owner.ownerId) !== null;
    } catch {
      // Transient (for example the file is busy); the next tick retries.
    }
  }

  // ---- runs & requests (§16.5 idempotent accept, §17.2 "accept request")

  async acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult> {
    return this.db.tx(() => {
      const now = nowIso();
      const existing = this.db.one<{ run_id: string; digest: string; expires_at: string }>("SELECT run_id, digest, expires_at FROM idempotency WHERE scope = ? AND key = ?", input.run.idempotencyScope, input.run.idempotencyKey);
      if (existing && existing.expires_at > now) {
        const run = this.loadRun(existing.run_id);
        if (run) {
          if (existing.digest !== input.run.requestDigest) {
            throw new SFieldError("IDEMPOTENCY_CONFLICT", `request key ${input.run.idempotencyKey} was used with a different payload`, { suggestion: "Reuse the original payload or choose a new request key" });
          }
          return { run, created: false };
        }
      }
      const run = { ...clone(input.run), epoch: 0, lastEventSeq: 0, createdAt: input.run.createdAt ?? now, updatedAt: now, wakeup: { at: now, reason: "accepted" } } as RunRecord;
      this.putRun(run);
      this.db.run(
        "INSERT INTO idempotency (scope, key, run_id, digest, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET run_id = excluded.run_id, digest = excluded.digest, expires_at = excluded.expires_at",
        input.run.idempotencyScope,
        input.run.idempotencyKey,
        run.runId,
        run.requestDigest,
        new Date(Date.parse(now) + input.retentionMs).toISOString(),
      );
      if (input.message) this.appendMessageSync(input.message);
      return { run: clone(run), created: true };
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.loadRun(runId);
  }

  async listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]> {
    const tenant = filter.tenantId || null;
    const conversation = filter.conversationId || null;
    const states = filter.state ? JSON.stringify(filter.state) : null;
    return this.db
      .all<BodyRow>(
        `SELECT body FROM runs WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR conversation_id = ?) AND (? IS NULL OR state IN (SELECT value FROM json_each(?)))
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        tenant,
        tenant,
        conversation,
        conversation,
        states,
        states,
        filter.limit ?? 100,
      )
      .map((r) => parse<RunRecord>(r.body));
  }

  async updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord> {
    return this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      const next: RunRecord = { ...run, ...clone(patch), updatedAt: nowIso(), epoch };
      this.putRun(next);
      return next;
    });
  }

  async listWakeups(): Promise<RunRecord[]> {
    return this.db.all<BodyRow>("SELECT body FROM runs WHERE wakeup_at IS NOT NULL ORDER BY rowid").map((r) => parse<RunRecord>(r.body));
  }

  async requestCancel(runId: string, reason?: string): Promise<void> {
    this.db.tx(() => {
      const run = this.mustRun(runId);
      if (!run.cancelRequested) run.cancelRequested = reason ? { at: nowIso(), reason } : { at: nowIso() };
      run.updatedAt = nowIso();
      this.putRun(run);
    });
  }

  // ---- ownership (§17.3): durable epoch per scope; release clears ownership but keeps the counter

  async claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null> {
    return this.db.tx(() => {
      const now = Date.now();
      const current = this.db.one<OwnershipRow>(SELECT_OWNERSHIP, scopeId);
      if (current && current.owner_id !== ownerId && Number(current.expires_at) > now) return null;
      let epoch: number;
      if (current && current.owner_id === ownerId && Number(current.expires_at) > now) epoch = Number(current.epoch);
      else {
        const counter = this.db.one<{ epoch: number }>("SELECT epoch FROM scope_epochs WHERE scope_id = ?", scopeId);
        epoch = (counter ? Number(counter.epoch) : 0) + 1;
        this.db.run("INSERT INTO scope_epochs (scope_id, epoch) VALUES (?, ?) ON CONFLICT(scope_id) DO UPDATE SET epoch = excluded.epoch", scopeId, epoch);
      }
      const expiresAt = now + leaseMs;
      this.db.run(
        "INSERT INTO ownership (scope_id, owner_id, epoch, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET owner_id = excluded.owner_id, epoch = excluded.epoch, expires_at = excluded.expires_at",
        scopeId,
        ownerId,
        epoch,
        expiresAt,
      );
      return { scopeId, ownerId, epoch, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  async renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null> {
    return this.db.tx(() => {
      const current = this.db.one<OwnershipRow>(SELECT_OWNERSHIP, claim.scopeId);
      if (!current || current.owner_id !== claim.ownerId || Number(current.epoch) !== claim.epoch || Number(current.expires_at) <= Date.now()) return null;
      const expiresAt = Date.now() + leaseMs;
      this.db.run("UPDATE ownership SET expires_at = ? WHERE scope_id = ?", expiresAt, claim.scopeId);
      return { scopeId: claim.scopeId, ownerId: claim.ownerId, epoch: claim.epoch, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  async release(claim: OwnershipClaim): Promise<void> {
    this.db.run("DELETE FROM ownership WHERE scope_id = ? AND owner_id = ? AND epoch = ?", claim.scopeId, claim.ownerId, claim.epoch);
  }

  async currentOwner(scopeId: string): Promise<OwnershipClaim | null> {
    const current = this.db.one<OwnershipRow>(SELECT_OWNERSHIP, scopeId);
    if (!current || Number(current.expires_at) <= Date.now()) return null;
    return { scopeId: current.scope_id, ownerId: current.owner_id, epoch: Number(current.epoch), expiresAt: new Date(Number(current.expires_at)).toISOString() };
  }

  /** Current authority is checked in the same transaction as the mutation; a stale epoch never writes (§17.3). */
  private assertOwner(run: RunRecord, epoch: number): void {
    const claim = this.db.one<OwnershipRow>(SELECT_OWNERSHIP, run.scopeId);
    if (!claim || Number(claim.epoch) !== epoch || Number(claim.expires_at) <= Date.now()) {
      throw new SFieldError("OWNERSHIP_LOST", `epoch ${epoch} no longer owns ${run.scopeId}`, { runId: run.runId });
    }
  }

  // ---- conversations

  async createConversation(rec: ConversationRecord): Promise<ConversationRecord> {
    return this.db.tx(() => {
      const existing = this.loadConversation(rec.id);
      if (existing) return existing;
      this.putConversation(rec);
      return clone(rec);
    });
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    return this.loadConversation(id);
  }

  /** Compare-and-set of the active run; a finished run releases the conversation even if its release was lost (§14.3). */
  async setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean> {
    return this.db.tx(() => {
      const c = this.loadConversation(conversationId);
      if (!c) return false;
      const current = c.activeRunId ?? null;
      if (runId !== null && current !== null && current !== runId && current !== (expectedActive ?? null)) {
        const activeRun = this.loadRun(current);
        if (activeRun && TERMINAL_RUN_STATES.has(activeRun.state)) {
          c.activeRunId = runId;
          this.putConversation(c);
          return true;
        }
        return false;
      }
      if (runId === null && expectedActive !== undefined && expectedActive !== null && current !== expectedActive) return false;
      if (runId === null) delete c.activeRunId;
      else c.activeRunId = runId;
      c.updatedAt = nowIso();
      this.putConversation(c);
      return true;
    });
  }

  private appendMessageSync(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): MessageRecord {
    const count = Number(this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", msg.conversationId)?.n ?? 0);
    const rec = { ...clone(msg), id: msg.id ?? newId("msg"), index: count } as MessageRecord;
    this.db.run("INSERT INTO messages (conversation_id, idx, id, expires_at, body) VALUES (?, ?, ?, ?, ?)", rec.conversationId, rec.index, rec.id, rec.expiresAt, JSON.stringify(rec));
    const c = this.loadConversation(msg.conversationId);
    if (c) {
      c.messageCount = count + 1;
      c.updatedAt = nowIso();
      this.putConversation(c);
    }
    return clone(rec);
  }

  async appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord> {
    return this.db.tx(() => this.appendMessageSync(msg));
  }

  async listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]> {
    const now = nowIso();
    const includeExpired = opts.includeExpired ? 1 : 0;
    const before = opts.before ?? null;
    // A positive limit keeps the newest `limit` messages in index order; anything else returns every match.
    const rows =
      opts.limit !== undefined && opts.limit > 0
        ? this.db.all<BodyRow>(
            `SELECT body FROM (SELECT idx, body FROM messages WHERE conversation_id = ? AND (? = 1 OR expires_at > ?) AND (? IS NULL OR idx < ?) ORDER BY idx DESC LIMIT ?) ORDER BY idx ASC`,
            conversationId,
            includeExpired,
            now,
            before,
            before,
            opts.limit,
          )
        : this.db.all<BodyRow>(
            "SELECT body FROM messages WHERE conversation_id = ? AND (? = 1 OR expires_at > ?) AND (? IS NULL OR idx < ?) ORDER BY idx ASC",
            conversationId,
            includeExpired,
            now,
            before,
            before,
          );
    return rows.map((r) => parse<MessageRecord>(r.body));
  }

  async deleteConversation(id: string): Promise<{ messages: number }> {
    return this.db.tx(() => {
      const n = Number(this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", id)?.n ?? 0);
      this.db.run("DELETE FROM messages WHERE conversation_id = ?", id);
      const c = this.loadConversation(id);
      if (c) {
        c.deletedAt = nowIso();
        c.messageCount = 0;
        this.putConversation(c);
      }
      return { messages: n };
    });
  }

  // ---- calls (§16.3 per-call state; §17.2 prepare batch / authorize dispatch / record intent / commit result)

  async prepareBatch(runId: string, epoch: number, calls: CallRecord[]): Promise<void> {
    this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      for (const call of calls) {
        this.db.run(
          "INSERT INTO calls (call_id, run_id, state, body) VALUES (?, ?, ?, ?) ON CONFLICT(call_id) DO UPDATE SET run_id = excluded.run_id, state = excluded.state, body = excluded.body",
          call.callId,
          runId,
          call.state,
          JSON.stringify(call),
        );
      }
    });
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    return this.loadCall(callId);
  }

  async listCalls(runId: string): Promise<CallRecord[]> {
    return this.db.all<BodyRow>("SELECT body FROM calls WHERE run_id = ? ORDER BY rowid", runId).map((r) => parse<CallRecord>(r.body));
  }

  async updateCall(runId: string, epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord> {
    return this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      const call = this.loadCall(callId);
      if (!call || call.runId !== runId) throw new SFieldError("NOT_FOUND", `call ${callId} not found in run ${runId}`);
      const next: CallRecord = { ...call, ...clone(patch), updatedAt: nowIso() };
      this.saveCall(next);
      return next;
    });
  }

  /** Checks ownership, approval, and call state, then reserves every budget scope in the same transaction. */
  async authorizeDispatch(input: {
    runId: string;
    epoch: number;
    callId: string;
    approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<DispatchDecision> {
    return this.db.tx((): DispatchDecision => {
      const run = this.mustRun(input.runId);
      this.assertOwner(run, input.epoch);
      const call = this.loadCall(input.callId);
      if (!call || call.runId !== input.runId) return { ok: false, code: "STATE_UNAVAILABLE", reason: "call not found" };
      if (call.state !== "prepared" && call.state !== "ready" && call.state !== "waiting_approval") return { ok: false, code: "STATE_UNAVAILABLE", reason: `call is ${call.state}` };
      if (input.approvalId) {
        const a = this.loadApproval(input.approvalId);
        if (!a || a.status !== "approved") return { ok: false, code: a?.status === "denied" ? "APPROVAL_DENIED" : "APPROVAL_REQUIRED", reason: `approval ${a?.status ?? "missing"}` };
        if (a.expiresAt <= nowIso()) return { ok: false, code: "APPROVAL_EXPIRED", reason: "approval expired" };
        if (!a.callIds.includes(input.callId)) return { ok: false, code: "APPROVAL_INVALID", reason: "call not covered" };
      }
      const reserved = this.reserveSync(input.reservation, input.scopes);
      if (!reserved.ok) return reserved;
      call.state = "ready";
      call.reservationId = reserved.id;
      call.updatedAt = nowIso();
      this.saveCall(call);
      return { ok: true, reservationId: reserved.id };
    });
  }

  async recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void> {
    this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      const call = this.loadCall(callId);
      if (!call) throw new SFieldError("NOT_FOUND", `call ${callId} not found`);
      if (call.state !== "ready") throw new SFieldError("STATE_UNAVAILABLE", `call ${callId} is ${call.state}, cannot record intent`);
      call.intent = clone(intent);
      call.state = "intent_committed";
      call.updatedAt = nowIso();
      this.saveCall(call);
    });
  }

  async commitResult(input: CommitResultInput): Promise<void> {
    this.db.tx(() => {
      const run = this.mustRun(input.runId);
      this.assertOwner(run, input.epoch);
      const call = this.loadCall(input.callId);
      if (!call || call.runId !== input.runId) throw new SFieldError("NOT_FOUND", `call ${input.callId} not found`);
      call.result = clone(input.result);
      call.state = input.state;
      if (input.attempt) call.attempts.push(clone(input.attempt));
      call.updatedAt = nowIso();
      this.saveCall(call);
      if (input.reservation) {
        const r = this.loadReservation(input.reservation.id);
        if (r) {
          r.actualMicroUsd = input.reservation.actualMicroUsd;
          r.state = input.reservation.state;
          r.updatedAt = nowIso();
          this.saveReservation(r);
        }
      }
      this.appendEventsSync(run, input.events);
      if (input.audit) this.appendAuditSync(input.audit);
    });
  }

  /** Appends an observation only; never a state transition (§17.2 "record late observation"). */
  async recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void> {
    this.db.tx(() => {
      const call = this.loadCall(callId);
      if (!call) throw new SFieldError("NOT_FOUND", `call ${callId} not found`);
      call.lateObservations = call.lateObservations ?? [];
      const entry: NonNullable<CallRecord["lateObservations"]>[number] = { at: nowIso(), observation: clone(observation) };
      if (actor) entry.actor = actor;
      call.lateObservations.push(entry);
      this.saveCall(call);
    });
  }

  // ---- approvals (§16.1; one decision plus the wake-up intent, §17.2 "decide approval/input")

  async createApproval(rec: ApprovalRecord): Promise<ApprovalRecord> {
    return this.db.tx(() => {
      this.putApproval(rec);
      const run = this.loadRun(rec.runId);
      if (run && !run.pending.approvals.includes(rec.id)) {
        run.pending.approvals.push(rec.id);
        this.putRun(run);
      }
      return clone(rec);
    });
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    return this.loadApproval(id);
  }

  async listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]> {
    const tenant = filter.tenantId || null;
    const runId = filter.runId || null;
    const statuses = filter.status ? JSON.stringify(filter.status) : null;
    return this.db
      .all<BodyRow>(
        "SELECT body FROM approvals WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR run_id = ?) AND (? IS NULL OR status IN (SELECT value FROM json_each(?))) ORDER BY rowid",
        tenant,
        tenant,
        runId,
        runId,
        statuses,
        statuses,
      )
      .map((r) => parse<ApprovalRecord>(r.body));
  }

  async decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }> {
    return this.db.tx(() => {
      const a = this.loadApproval(input.id);
      if (!a) throw new SFieldError("NOT_FOUND", `approval ${input.id} not found`);
      if (a.status !== "pending") {
        if (a.decision && a.decision.decision === input.decision) return { approval: a, changed: false };
        throw new SFieldError("APPROVAL_ALREADY_DECIDED", `approval ${a.id} was already ${a.status}`);
      }
      a.status = input.decision === "approve" ? "approved" : "denied";
      a.decision = { actor: { tenantId: input.actor.tenantId, subjectId: input.actor.subjectId }, decision: input.decision, decidedAt: input.now };
      if (input.comment) a.decision.comment = input.comment;
      this.putApproval(a);
      const run = this.loadRun(a.runId);
      if (run) {
        run.wakeup = { at: input.now, reason: `approval_${input.decision}` };
        this.putRun(run);
      }
      return { approval: clone(a), changed: true };
    });
  }

  async consumeApproval(id: string, runId: string, epoch: number): Promise<ApprovalRecord> {
    return this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      const a = this.loadApproval(id);
      if (!a) throw new SFieldError("NOT_FOUND", `approval ${id} not found`);
      if (a.status === "approved") {
        a.status = "consumed";
        a.consumedAt = nowIso();
        this.putApproval(a);
      }
      run.pending.approvals = run.pending.approvals.filter((x) => x !== id);
      this.putRun(run);
      return clone(a);
    });
  }

  // ---- input requests (§14.4)

  async createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord> {
    return this.db.tx(() => {
      this.putInputRequest(rec);
      const run = this.loadRun(rec.runId);
      if (run && !run.pending.inputs.includes(rec.requestId)) {
        run.pending.inputs.push(rec.requestId);
        this.putRun(run);
      }
      return clone(rec);
    });
  }

  async getInputRequest(id: string): Promise<InputRequestRecord | null> {
    return this.loadInputRequest(id);
  }

  async listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]> {
    const tenant = filter.tenantId || null;
    const runId = filter.runId || null;
    const statuses = filter.status ? JSON.stringify(filter.status) : null;
    return this.db
      .all<BodyRow>(
        "SELECT body FROM input_requests WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR run_id = ?) AND (? IS NULL OR status IN (SELECT value FROM json_each(?))) ORDER BY rowid",
        tenant,
        tenant,
        runId,
        runId,
        statuses,
        statuses,
      )
      .map((r) => parse<InputRequestRecord>(r.body));
  }

  async answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }> {
    return this.db.tx(() => {
      const r = this.loadInputRequest(input.id);
      if (!r) throw new SFieldError("NOT_FOUND", `input request ${input.id} not found`);
      if (r.status !== "pending") {
        if (r.answer && JSON.stringify(r.answer.value) === JSON.stringify(input.value)) return { request: r, changed: false };
        throw new SFieldError("VERSION_CONFLICT", `question ${r.requestId} was already answered`);
      }
      r.status = "answered";
      r.answer = { actor: { tenantId: input.actor.tenantId, subjectId: input.actor.subjectId }, value: clone(input.value), answeredAt: input.now };
      this.putInputRequest(r);
      const run = this.loadRun(r.runId);
      if (run) {
        run.wakeup = { at: input.now, reason: "input_answered" };
        run.pending.inputs = run.pending.inputs.filter((x) => x !== r.requestId);
        this.putRun(run);
      }
      return { request: clone(r), changed: true };
    });
  }

  // ---- checkpoints & events (§17.4, §19.2)

  async saveCheckpoint(runId: string, epoch: number, checkpoint: Checkpoint): Promise<void> {
    this.db.tx(() => {
      const run = this.mustRun(runId);
      this.assertOwner(run, epoch);
      this.db.run("INSERT INTO checkpoints (run_id, body) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET body = excluded.body", runId, JSON.stringify(checkpoint));
    });
  }

  async getCheckpoint(runId: string): Promise<Checkpoint | null> {
    const row = this.db.one<BodyRow>("SELECT body FROM checkpoints WHERE run_id = ?", runId);
    return row ? parse<Checkpoint>(row.body) : null;
  }

  /** Assigns the next per-run `seq` to each event, trims beyond the retention window, and persists the run's counter. */
  private appendEventsSync(run: RunRecord, events: RunEvent[]): RunEvent[] {
    const out: RunEvent[] = [];
    if (events.length === 0) return out;
    for (const ev of events) {
      const seq = ++run.lastEventSeq;
      const stored: RunEvent = { ...clone(ev), seq };
      this.db.run("INSERT INTO events (run_id, seq, body) VALUES (?, ?, ?)", run.runId, seq, JSON.stringify(stored));
      out.push(stored);
    }
    if (run.lastEventSeq > this.eventRetention) this.db.run("DELETE FROM events WHERE run_id = ? AND seq <= ?", run.runId, run.lastEventSeq - this.eventRetention);
    this.putRun(run);
    return out;
  }

  async appendEvents(runId: string, epoch: number | null, events: RunEvent[]): Promise<RunEvent[]> {
    return this.db.tx(() => {
      const run = this.mustRun(runId);
      if (epoch !== null) this.assertOwner(run, epoch);
      return this.appendEventsSync(run, events);
    });
  }

  async readEvents(runId: string, afterSeq: number, limit = 1000): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }> {
    return this.db.tx(() => {
      const run = this.mustRun(runId);
      const oldest = this.db.one<{ s: number | null }>("SELECT MIN(seq) AS s FROM events WHERE run_id = ?", runId)?.s ?? null;
      const gap = oldest !== null && afterSeq + 1 < Number(oldest);
      const events = this.db.all<BodyRow>("SELECT body FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?", runId, afterSeq, limit).map((r) => parse<RunEvent>(r.body));
      return { events, gap, lastSeq: run.lastEventSeq };
    });
  }

  // ---- audit (§19.3)

  private appendAuditSync(records: AuditRecord[]): void {
    for (const rec of records) {
      this.db.run("INSERT INTO audit (id, tenant_id, run_id, type, body) VALUES (?, ?, ?, ?, ?)", rec.id, rec.tenantId, rec.runId ?? null, rec.type, JSON.stringify(rec));
    }
  }

  async appendAudit(records: AuditRecord[]): Promise<void> {
    this.db.tx(() => this.appendAuditSync(records));
  }

  async readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]> {
    const tenant = filter.tenantId || null;
    const runId = filter.runId || null;
    const type = filter.type || null;
    const limit = filter.limit ?? 1000;
    // The newest `limit` matching records, returned in append order; a non-positive limit returns every match.
    return this.db
      .all<BodyRow>(
        `SELECT body FROM (SELECT ord, body FROM audit WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR run_id = ?) AND (? IS NULL OR type = ?) ORDER BY ord DESC LIMIT ?) ORDER BY ord ASC`,
        tenant,
        tenant,
        runId,
        runId,
        type,
        type,
        limit > 0 ? limit : -1,
      )
      .map((r) => parse<AuditRecord>(r.body));
  }

  // ---- budgets (§15.2 reservation protocol, §15.3 settlement)

  private reserveSync(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): ReserveDecision {
    for (const scope of scopes) {
      const usage = this.scopeUsageSync(scope.key);
      if (usage.heldMicroUsd + usage.settledMicroUsd + input.estimateMicroUsd > scope.ceilingMicroUsd) {
        return { ok: false, code: "BUDGET_EXHAUSTED", reason: `scope ${scope.key}: ${usage.heldMicroUsd + usage.settledMicroUsd} used + ${input.estimateMicroUsd} estimate exceeds ${scope.ceilingMicroUsd} micro-USD` };
      }
    }
    const now = nowIso();
    const rec: ReservationRecord = { ...clone(input), id: newId("rsv"), scopes: scopes.map((s) => s.key), state: "held", createdAt: now, updatedAt: now };
    this.db.run("INSERT INTO reservations (id, run_id, state, estimate_micro_usd, actual_micro_usd, body) VALUES (?, ?, ?, ?, ?, ?)", rec.id, rec.runId, rec.state, rec.estimateMicroUsd, rec.actualMicroUsd ?? null, JSON.stringify(rec));
    for (const key of rec.scopes) this.db.run("INSERT OR IGNORE INTO reservation_scopes (reservation_id, scope_key) VALUES (?, ?)", rec.id, key);
    return { ok: true, id: rec.id };
  }

  async reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<ReserveDecision> {
    return this.db.tx(() => this.reserveSync(input, scopes));
  }

  async settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void> {
    this.db.tx(() => {
      const r = this.loadReservation(id);
      if (!r) throw new SFieldError("NOT_FOUND", `reservation ${id} not found`);
      if (r.state === "settled" || r.state === "released") return; // idempotent
      if (state === "released" && r.state !== "held") throw new SFieldError("STATE_UNAVAILABLE", `reservation ${id} was dispatched; it cannot be freely released`);
      r.actualMicroUsd = actualMicroUsd;
      r.state = state;
      r.updatedAt = nowIso();
      this.saveReservation(r);
    });
  }

  async getReservation(id: string): Promise<ReservationRecord | null> {
    return this.loadReservation(id);
  }

  /** Held = estimates of held/dispatched plus max(estimate, actual) of uncertain; settled = actuals of settled. */
  private scopeUsageSync(scopeKey: string): { heldMicroUsd: number; settledMicroUsd: number } {
    const row = this.db.one<{ held: number; settled: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN r.state IN ('held', 'dispatched') THEN r.estimate_micro_usd
                           WHEN r.state = 'uncertain' THEN MAX(r.estimate_micro_usd, COALESCE(r.actual_micro_usd, 0))
                           ELSE 0 END), 0) AS held,
         COALESCE(SUM(CASE WHEN r.state = 'settled' THEN COALESCE(r.actual_micro_usd, 0) ELSE 0 END), 0) AS settled
       FROM reservations r JOIN reservation_scopes s ON s.reservation_id = r.id
       WHERE s.scope_key = ?`,
      scopeKey,
    );
    return { heldMicroUsd: Number(row?.held ?? 0), settledMicroUsd: Number(row?.settled ?? 0) };
  }

  async scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }> {
    return this.scopeUsageSync(scopeKey);
  }

  // ---- model attempts, context explanations

  async recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void> {
    this.db.run("INSERT INTO model_attempts (run_id, attempt_id, body) VALUES (?, ?, ?)", runId, rec.attemptId, JSON.stringify(rec));
  }

  async listModelAttempts(runId: string): Promise<ModelAttemptRecord[]> {
    return this.db.all<BodyRow>("SELECT body FROM model_attempts WHERE run_id = ? ORDER BY ord", runId).map((r) => parse<ModelAttemptRecord>(r.body));
  }

  async saveContextExplanation(rec: ContextExplanation): Promise<void> {
    this.db.run("INSERT INTO context_explanations (context_id, run_id, body) VALUES (?, ?, ?) ON CONFLICT(context_id) DO UPDATE SET run_id = excluded.run_id, body = excluded.body", rec.contextId, rec.runId, JSON.stringify(rec));
  }

  async getContextExplanation(id: string): Promise<ContextExplanation | null> {
    const row = this.db.one<BodyRow>("SELECT body FROM context_explanations WHERE context_id = ?", id);
    return row ? parse<ContextExplanation>(row.body) : null;
  }

  // ---- governance (§16.6): lock-manifest approvals are write-once per digest

  readonly lockApprovals = {
    get: async (digest: string): Promise<LockApprovalRecord | null> => {
      const row = this.db.one<BodyRow>("SELECT body FROM lock_approvals WHERE digest = ?", digest);
      return row ? parse<LockApprovalRecord>(row.body) : null;
    },
    put: async (rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }> => {
      return this.db.tx(() => {
        const row = this.db.one<BodyRow>("SELECT body FROM lock_approvals WHERE digest = ?", rec.digest);
        if (row) return { record: parse<LockApprovalRecord>(row.body), changed: false };
        this.db.run("INSERT INTO lock_approvals (digest, suite, decided_at, body) VALUES (?, ?, ?, ?)", rec.digest, rec.suite ?? null, rec.decidedAt, JSON.stringify(rec));
        return { record: clone(rec), changed: true };
      });
    },
    latest: async (suite?: string): Promise<LockApprovalRecord | null> => {
      const row = suite
        ? this.db.one<BodyRow>("SELECT body FROM lock_approvals WHERE suite = ? ORDER BY decided_at DESC LIMIT 1", suite)
        : this.db.one<BodyRow>("SELECT body FROM lock_approvals ORDER BY decided_at DESC LIMIT 1");
      return row ? parse<LockApprovalRecord>(row.body) : null;
    },
  };

  readonly evalReports = {
    get: async (id: string): Promise<EvalReportRecord | null> => {
      const row = this.db.one<BodyRow>("SELECT body FROM eval_reports WHERE id = ?", id);
      return row ? parse<EvalReportRecord>(row.body) : null;
    },
    put: async (rec: EvalReportRecord): Promise<void> => {
      this.db.run(
        "INSERT INTO eval_reports (id, suite, candidate_digest, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET suite = excluded.suite, candidate_digest = excluded.candidate_digest, body = excluded.body",
        rec.id,
        rec.suite,
        rec.candidateDigest,
        JSON.stringify(rec),
      );
    },
    list: async (filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]> => {
      const suite = filter.suite || null;
      const digest = filter.candidateDigest || null;
      return this.db
        .all<BodyRow>("SELECT body FROM eval_reports WHERE (? IS NULL OR suite = ?) AND (? IS NULL OR candidate_digest = ?) ORDER BY rowid", suite, suite, digest, digest)
        .map((r) => parse<EvalReportRecord>(r.body));
    },
  };

  // ---- record helpers: JSON body plus the indexed columns, always derived from the record being written

  private loadRun(runId: string): RunRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM runs WHERE run_id = ?", runId);
    return row ? parse<RunRecord>(row.body) : null;
  }

  private mustRun(runId: string): RunRecord {
    const run = this.loadRun(runId);
    if (!run) throw new SFieldError("NOT_FOUND", `run ${runId} not found`);
    return run;
  }

  private putRun(run: RunRecord): void {
    this.db.run(UPSERT_RUN, run.runId, run.tenantId, run.conversationId ?? null, run.scopeId, run.state, run.createdAt, run.wakeup ? (run.wakeup.at ?? "") : null, JSON.stringify(run));
  }

  private loadConversation(id: string): ConversationRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM conversations WHERE id = ?", id);
    return row ? parse<ConversationRecord>(row.body) : null;
  }

  private putConversation(rec: ConversationRecord): void {
    this.db.run("INSERT INTO conversations (id, tenant_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, body = excluded.body", rec.id, rec.tenantId, JSON.stringify(rec));
  }

  private loadCall(callId: string): CallRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM calls WHERE call_id = ?", callId);
    return row ? parse<CallRecord>(row.body) : null;
  }

  private saveCall(call: CallRecord): void {
    this.db.run("UPDATE calls SET state = ?, body = ? WHERE call_id = ?", call.state, JSON.stringify(call), call.callId);
  }

  private loadApproval(id: string): ApprovalRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM approvals WHERE id = ?", id);
    return row ? parse<ApprovalRecord>(row.body) : null;
  }

  private putApproval(rec: ApprovalRecord): void {
    this.db.run(
      "INSERT INTO approvals (id, tenant_id, run_id, status, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, run_id = excluded.run_id, status = excluded.status, body = excluded.body",
      rec.id,
      rec.tenantId,
      rec.runId,
      rec.status,
      JSON.stringify(rec),
    );
  }

  private loadInputRequest(id: string): InputRequestRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM input_requests WHERE id = ?", id);
    return row ? parse<InputRequestRecord>(row.body) : null;
  }

  private putInputRequest(rec: InputRequestRecord): void {
    this.db.run(
      "INSERT INTO input_requests (id, tenant_id, run_id, status, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, run_id = excluded.run_id, status = excluded.status, body = excluded.body",
      rec.requestId,
      rec.tenantId,
      rec.runId,
      rec.status,
      JSON.stringify(rec),
    );
  }

  private loadReservation(id: string): ReservationRecord | null {
    const row = this.db.one<BodyRow>("SELECT body FROM reservations WHERE id = ?", id);
    return row ? parse<ReservationRecord>(row.body) : null;
  }

  private saveReservation(rec: ReservationRecord): void {
    this.db.run("UPDATE reservations SET state = ?, estimate_micro_usd = ?, actual_micro_usd = ?, body = ? WHERE id = ?", rec.state, rec.estimateMicroUsd, rec.actualMicroUsd ?? null, JSON.stringify(rec), rec.id);
  }
}

/** JSON round trip: drops `undefined` members exactly like the reference store's deepClone. */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

/** Signal 0 probes existence; EPERM means the process exists but belongs to another user. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
