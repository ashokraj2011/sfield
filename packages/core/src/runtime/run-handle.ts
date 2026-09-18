/** RunHandle over persisted events with live tailing and explicit disconnect semantics (§7.1, §19.2). */
import type { JsonValue, Principal } from "../types/common.js";
import type { ExecutionPersistence } from "../types/persistence.js";
import type { RunEvent, RunHandle, RunResult, RunSnapshot } from "../types/runtime.js";
import { isTerminal, SUSPENDED_RUN_STATES } from "../types/runtime.js";
import { SFieldError } from "../errors.js";
import { newId, nowIso } from "../util/digest.js";
import type { EventBus } from "./events.js";
import type { Scheduler } from "./scheduler.js";

const END_EVENTS = new Set(["run_finished", "run_suspended", "reconciliation_required"]);

export class RunHandleImpl implements RunHandle {
  constructor(
    private readonly deps: { persistence: ExecutionPersistence; bus: EventBus; scheduler: Scheduler },
    readonly id: string,
    readonly idempotencyKey: string,
    private readonly principal: Principal,
  ) {}

  async *events(opts: { after?: string } = {}): AsyncIterable<RunEvent> {
    const q = this.deps.bus.subscribe(this.id);
    let cursor = opts.after ? Number(opts.after) : 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    try {
      const first = await this.deps.persistence.readEvents(this.id, cursor);
      if (first.gap) {
        yield { v: 1, id: newId("evt"), runId: this.id, timestamp: nowIso(), type: "gap", payload: { after: cursor, snapshotCursor: first.lastSeq }, provisional: true };
        cursor = first.lastSeq;
      }
      let ended = false;
      for (const ev of first.events) {
        yield ev;
        cursor = ev.seq ?? cursor;
        if (END_EVENTS.has(ev.type)) ended = true;
      }
      if (ended) return;
      const run = await this.deps.persistence.getRun(this.id);
      if (run && (isTerminal(run.state) || SUSPENDED_RUN_STATES.has(run.state)) && run.lastEventSeq <= cursor) return;
      for await (const ev of q) {
        if (ev.seq !== undefined && ev.seq <= cursor) continue;
        yield ev;
        if (ev.seq !== undefined) cursor = ev.seq;
        if (END_EVENTS.has(ev.type)) return;
      }
      // Queue closed: drain anything committed after the cursor.
      const tail = await this.deps.persistence.readEvents(this.id, cursor);
      for (const ev of tail.events) yield ev;
      if (q.overflow) yield { v: 1, id: newId("evt"), runId: this.id, timestamp: nowIso(), type: "disconnected", payload: { reason: "buffer_overflow", resumeAfter: tail.lastSeq }, provisional: true };
    } finally {
      this.deps.bus.unsubscribe(this.id, q);
    }
  }

  async snapshot(): Promise<RunSnapshot> {
    const run = await this.deps.persistence.getRun(this.id);
    if (!run || run.tenantId !== this.principal.tenantId) throw new SFieldError("NOT_FOUND", `run ${this.id} not found`);
    const calls = await this.deps.persistence.listCalls(this.id);
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      agentId: run.agentId,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      configDigest: run.configDigest,
      output: run.output,
      pending: run.pending,
      effects: run.effects,
      usage: run.usage,
      error: run.error,
      calls: calls.map((c) => ({ callId: c.callId, toolRef: c.toolRef, state: c.state, effect: c.result?.effect ?? "not_started", status: c.result?.status })),
      lastEventSeq: run.lastEventSeq,
    };
  }

  async result(): Promise<RunResult> {
    await this.deps.scheduler.completion(this.id);
    const run = await this.deps.persistence.getRun(this.id);
    if (!run) throw new SFieldError("NOT_FOUND", `run ${this.id} not found`);
    return toResult(run);
  }

  async cancel(reason?: string): Promise<void> {
    await this.deps.scheduler.cancel(this.id, reason);
  }
}

export function toResult(run: { runId: string; state: RunResult["state"]; output?: JsonValue; pending: { approvals: string[]; inputs: string[] }; effects: RunResult["effects"]; usage: RunResult["usage"]; error?: RunResult["error"]; citations?: RunResult["citations"] }): RunResult {
  const out: RunResult = { runId: run.runId, state: run.state, effects: run.effects, usage: run.usage };
  if (run.output !== undefined) out.output = run.output;
  if (run.pending.approvals.length || run.pending.inputs.length) out.pending = run.pending;
  if (run.error) out.error = run.error;
  if (run.citations && Object.keys(run.citations).length) out.citations = run.citations;
  return out;
}
