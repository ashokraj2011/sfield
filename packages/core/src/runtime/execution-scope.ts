/** Execution scopes for external loops (§7.2): tool accounting is guaranteed by registry.execute; model usage is reported. */
import type { JsonObject, JsonValue, Principal } from "../types/common.js";
import type { EffectiveConfig } from "../config/types.js";
import type { ExecutionPersistence, OwnershipClaim, RunRecord } from "../types/persistence.js";
import type { RunResult } from "../types/runtime.js";
import type { ToolResult } from "../types/tool.js";
import { SFieldError } from "../errors.js";
import { digestJson, newId, nowIso } from "../util/digest.js";
import type { ToolRegistry, ToolDescription } from "../registry/registry.js";
import type { ToolPipeline } from "../pipeline/execute.js";
import type { ApprovalService } from "../policy/approvals.js";
import type { PolicyPreset } from "../policy/presets.js";
import type { EventBus } from "./events.js";
import { toResult } from "./run-handle.js";

export interface ExecutionScopeOptions {
  principal: Principal;
  purpose: string;
  budget?: { maxCostMicroUsd?: number; maxToolCalls?: number };
  preset?: PolicyPreset;
}

export interface ExecutionScopeDeps {
  config: EffectiveConfig;
  persistence: ExecutionPersistence;
  registry: ToolRegistry;
  pipeline: ToolPipeline;
  approvals: ApprovalService;
  bus: EventBus;
  ownerId: string;
  leaseMs: number;
  presetName?: string;
}

export interface ExecutionScope {
  readonly id: string;
  readonly principal: Principal;
  registry: {
    list(): ToolDescription[];
    describe(ref: string): ToolDescription;
    execute(ref: string, inputs: JsonObject, opts?: { callId?: string; signal?: AbortSignal }): Promise<ToolResult>;
  };
  /** Reports model usage made outside the harness so the scope's accounting is honest. */
  modelCall(usage: { inputTokens: number; outputTokens: number; costMicroUsd?: number; model?: string }): Promise<void>;
  checkpoint(note?: string): Promise<void>;
  close(): Promise<RunResult>;
}

export class ExternalExecutionScope implements ExecutionScope {
  readonly id: string;
  readonly principal: Principal;
  private claim!: OwnershipClaim;
  private run!: RunRecord;
  private calls = 0;
  private closed = false;
  private renew?: NodeJS.Timeout;
  private readonly preset: PolicyPreset;
  private readonly budget: { maxCostMicroUsd: number; maxToolCalls: number };

  constructor(
    private readonly deps: ExecutionScopeDeps,
    opts: ExecutionScopeOptions,
  ) {
    this.id = newId("run");
    this.principal = opts.principal;
    this.preset = opts.preset ?? "supervised";
    this.budget = { maxCostMicroUsd: opts.budget?.maxCostMicroUsd ?? 1_000_000, maxToolCalls: opts.budget?.maxToolCalls ?? 50 };
    this.purpose = opts.purpose;
  }
  private readonly purpose: string;

  async open(): Promise<this> {
    const now = nowIso();
    const accepted = await this.deps.persistence.acceptRequest({
      run: {
        runId: this.id,
        tenantId: this.principal.tenantId,
        subjectId: this.principal.subjectId,
        principal: this.principal,
        agentId: `external:${this.purpose}`,
        kind: "external",
        scopeId: this.id,
        state: "running",
        request: { message: { text: this.purpose } },
        requestDigest: digestJson({ purpose: this.purpose, at: now }),
        idempotencyKey: this.id,
        idempotencyScope: JSON.stringify([this.principal.tenantId, this.principal.subjectId, "external", this.id]),
        configDigest: this.deps.config.digest,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        effects: [],
        usage: { turns: 0, modelCalls: 0, providerAttempts: 0, toolCalls: 0, toolAttempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensReported: false, costMicroUsd: 0, costLabel: "best_effort", activeMs: 0, elapsedMs: 0 },
        pending: { approvals: [], inputs: [] },
        preset: this.deps.presetName,
      },
      retentionMs: 86400000,
    });
    this.run = accepted.run;
    const claim = await this.deps.persistence.claim(this.id, this.deps.ownerId, this.deps.leaseMs);
    if (!claim) throw new SFieldError("OWNERSHIP_UNAVAILABLE", "could not claim the execution scope");
    this.claim = claim;
    await this.deps.persistence.updateRun(this.id, claim.epoch, { wakeup: null });
    this.renew = setInterval(() => void this.deps.persistence.renew(this.claim, this.deps.leaseMs).catch(() => undefined), Math.max(1000, this.deps.leaseMs / 3));
    this.renew.unref();
    this.deps.registry.freeze();
    return this;
  }

  readonly registry = {
    list: (): ToolDescription[] => this.deps.registry.list().map((d) => this.deps.registry.describe(d.ref)),
    describe: (ref: string): ToolDescription => this.deps.registry.describe(ref),
    execute: async (ref: string, inputs: JsonObject, opts: { callId?: string; signal?: AbortSignal } = {}): Promise<ToolResult> => {
      if (this.closed) throw new SFieldError("STATE_UNAVAILABLE", "execution scope is closed");
      const def = this.deps.registry.resolve(ref);
      if (def.source === "builtin") throw new SFieldError("ACCESS_DENIED", "built-in interaction tools are not available to external loops");
      const p = this.deps.persistence;
      const existing = opts.callId ? await p.getCall(opts.callId) : null;
      const callId = existing?.callId ?? newId("call");
      if (!existing) {
        if (this.calls >= this.budget.maxToolCalls) throw new SFieldError("BUDGET_EXHAUSTED", `scope tool-call budget ${this.budget.maxToolCalls} reached`);
        this.calls++;
        await p.prepareBatch(this.id, this.claim.epoch, [{ callId, runId: this.id, batchId: newId("batch"), turn: this.calls, order: 0, toolRef: def.ref, state: "proposed", proposedArguments: inputs, attempts: [], createdAt: nowIso(), updatedAt: nowIso() }]);
      } else if (existing.result && existing.state !== "waiting_approval") {
        return existing.result; // confirmed result is reused, never re-executed (§16.4)
      }
      const prepared = await this.deps.pipeline.prepare({ def, inputs, principal: this.principal, runId: this.id, callId, preset: this.preset });
      await p.updateCall(this.id, this.claim.epoch, callId, { state: "prepared", invocation: prepared.invocation });
      let approvalId: string | undefined;
      if (prepared.approval.required) {
        let approval = existing?.approvalId ? await p.getApproval(existing.approvalId) : null;
        if (!approval || approval.preparedDigests[0] !== prepared.invocation.digest) {
          approval = await this.deps.approvals.create({ runId: this.id, tenantId: this.principal.tenantId, requesterSubjectId: this.principal.subjectId, agentId: this.run.agentId, invocations: [prepared.invocation], views: [prepared.view] });
          await p.updateCall(this.id, this.claim.epoch, callId, { state: "waiting_approval", approvalId: approval.id });
          const evs = await p.appendEvents(this.id, this.claim.epoch, [{ v: 1, id: newId("evt"), runId: this.id, timestamp: nowIso(), type: "approval_requested", payload: { approvalId: approval.id, callIds: [callId], expiresAt: approval.expiresAt } }]);
          this.deps.bus.publish(evs);
          await this.deps.approvals.notify(approval).catch(() => undefined);
          approval = (await p.getApproval(approval.id)) ?? approval;
        }
        if (approval.status === "pending") {
          throw new SFieldError("APPROVAL_REQUIRED", `call ${callId} awaits approval ${approval.id}`, { runId: this.id, callId, details: { approvalId: approval.id, callId } , suggestion: "Decide the approval, then call execute again with the same callId"});
        }
        if (approval.status !== "approved") throw new SFieldError("APPROVAL_DENIED", `approval ${approval.id} is ${approval.status}`, { runId: this.id, callId });
        approvalId = approval.id;
      }
      const out = await this.deps.pipeline.dispatch({
        prepared,
        principal: this.principal,
        runId: this.id,
        epoch: this.claim.epoch,
        approvalId,
        signal: opts.signal ?? new AbortController().signal,
        budgetScopes: [{ key: JSON.stringify(["run", this.id]), ceilingMicroUsd: this.budget.maxCostMicroUsd }],
        onEvents: (evs) => this.deps.bus.publish(evs),
      });
      return out.result;
    },
  };

  async modelCall(usage: { inputTokens: number; outputTokens: number; costMicroUsd?: number; model?: string }): Promise<void> {
    await this.deps.persistence.recordModelAttempt(this.id, { attemptId: newId("att"), modelBindingId: "external", model: usage.model ?? "external", startedAt: nowIso(), durationMs: 0, status: "succeeded", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reported: true }, costMicroUsd: usage.costMicroUsd, compiledDigest: "external" });
    const run = await this.deps.persistence.getRun(this.id);
    if (!run) return;
    const u = run.usage;
    await this.deps.persistence.updateRun(this.id, this.claim.epoch, { usage: { ...u, modelCalls: u.modelCalls + 1, inputTokens: u.inputTokens + usage.inputTokens, outputTokens: u.outputTokens + usage.outputTokens, totalTokens: u.totalTokens + usage.inputTokens + usage.outputTokens, costMicroUsd: u.costMicroUsd + (usage.costMicroUsd ?? 0) } });
  }

  async checkpoint(note?: string): Promise<void> {
    await this.deps.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: this.principal.tenantId, runId: this.id, type: "external_checkpoint", principal: { tenantId: this.principal.tenantId, subjectId: this.principal.subjectId }, data: { note: note ?? null, calls: this.calls } }]);
  }

  async close(): Promise<RunResult> {
    if (this.closed) return toResult((await this.deps.persistence.getRun(this.id))!);
    this.closed = true;
    if (this.renew) clearInterval(this.renew);
    const calls = await this.deps.persistence.listCalls(this.id);
    const effects = calls
      .filter((c) => c.invocation && this.deps.registry.get(c.toolRef)?.policy.effect !== "read")
      .map((c) => ({ callId: c.callId, toolRef: c.toolRef, effect: this.deps.registry.get(c.toolRef)!.policy.effect, outcome: c.result?.effect ?? ("unknown" as const), resource: c.invocation!.resource }));
    const run = await this.deps.persistence.getRun(this.id);
    const unresolved = calls.some((c) => c.state === "outcome_unknown" || c.state === "intent_committed");
    const state = unresolved ? "reconciliation_required" : "completed";
    const updated = await this.deps.persistence.updateRun(this.id, this.claim.epoch, { state, effects, usage: { ...run!.usage, toolCalls: calls.length } });
    const evs = await this.deps.persistence.appendEvents(this.id, this.claim.epoch, [{ v: 1, id: newId("evt"), runId: this.id, timestamp: nowIso(), type: "run_finished", payload: { state, effects: effects as unknown as JsonValue } }]);
    this.deps.bus.publish(evs);
    await this.deps.persistence.release(this.claim);
    this.deps.bus.end(this.id);
    return toResult(updated);
  }
}
