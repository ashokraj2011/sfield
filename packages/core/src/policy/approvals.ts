/** Approval and input services (§16.1, §14.4). */
import type { Actor, JsonObject, JsonValue } from "../types/common.js";
import type { ApprovalTransport, InputTransport } from "../types/options.js";
import type { ApprovalRecord, ApprovalView, ExecutionPersistence, InputRequestRecord } from "../types/persistence.js";
import type { PreparedInvocation } from "../types/tool.js";
import { SFieldError } from "../errors.js";
import { newId, nowIso, isoAfter } from "../util/digest.js";
import { sharedValidator } from "../schema/validator.js";

export interface ApprovalServiceOptions {
  persistence: ExecutionPersistence;
  transport?: ApprovalTransport;
  inputTransport?: InputTransport;
  approvalExpiryMs: number;
  inputExpiryMs: number;
  /** Called after a committed decision/answer so the scheduler can resume the run. */
  onWakeup: (runId: string, reason: string) => void;
  preset?: string;
}

export class ApprovalService {
  constructor(private readonly opts: ApprovalServiceOptions) {}

  get hasTransport(): boolean {
    return !!this.opts.transport;
  }

  get hasInputTransport(): boolean {
    return !!this.opts.inputTransport;
  }

  async create(input: { runId: string; tenantId: string; requesterSubjectId: string; agentId: string; invocations: PreparedInvocation[]; views: ApprovalView[] }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: newId("apr"),
      tenantId: input.tenantId,
      runId: input.runId,
      callIds: input.invocations.map((i) => i.callId),
      preparedDigests: input.invocations.map((i) => i.digest),
      requesterSubjectId: input.requesterSubjectId,
      allowedApproverPolicyId: "host",
      view: input.views,
      expiresAt: isoAfter(this.opts.approvalExpiryMs),
      maxUses: 1,
      status: "pending",
      createdAt: nowIso(),
    };
    return this.opts.persistence.createApproval(record);
  }

  /** Notifies the transport; decisions arrive through decide(). Transport failures do not lose the suspension. */
  async notify(approval: ApprovalRecord): Promise<void> {
    if (!this.opts.transport) return;
    await this.opts.transport.request({
      approval,
      views: approval.view,
      decide: (decision, actor, comment) => this.decide({ approvalId: approval.id, actor, decision, comment }).then(() => undefined),
    });
  }

  async decide(input: { approvalId: string; actor: Actor; decision: "approve" | "deny"; comment?: string }): Promise<ApprovalRecord> {
    const existing = await this.opts.persistence.getApproval(input.approvalId);
    if (!existing) throw new SFieldError("NOT_FOUND", `approval ${input.approvalId} not found`);
    if (existing.tenantId !== input.actor.tenantId) throw new SFieldError("ACCESS_DENIED", "actor tenant does not match the approval");
    const now = nowIso();
    if (existing.status === "pending" && existing.expiresAt <= now) {
      await this.opts.persistence.decideApproval({ id: existing.id, actor: input.actor, decision: "deny", comment: "expired", now });
      throw new SFieldError("APPROVAL_EXPIRED", `approval ${existing.id} expired at ${existing.expiresAt}`);
    }
    const { approval, changed } = await this.opts.persistence.decideApproval({ id: existing.id, actor: input.actor, decision: input.decision, comment: input.comment, now });
    if (changed) this.opts.onWakeup(approval.runId, `approval_${input.decision}`);
    return approval;
  }

  /** Approval validity at dispatch: approved, unexpired, unconsumed, digests unchanged (§16.1). */
  validate(approval: ApprovalRecord | null, invocation: PreparedInvocation): { ok: true } | { ok: false; code: string; reason: string } {
    if (!approval) return { ok: false, code: "APPROVAL_REQUIRED", reason: "no approval record" };
    if (approval.status === "denied") return { ok: false, code: "APPROVAL_DENIED", reason: "denied by approver" };
    if (approval.status === "consumed") return { ok: false, code: "APPROVAL_INVALID", reason: "approval already consumed" };
    if (approval.status === "expired") return { ok: false, code: "APPROVAL_EXPIRED", reason: "approval expired" };
    if (approval.status !== "approved") return { ok: false, code: "APPROVAL_REQUIRED", reason: `approval ${approval.status}` };
    if (approval.expiresAt <= nowIso()) return { ok: false, code: "APPROVAL_EXPIRED", reason: "approval expired" };
    if (!approval.callIds.includes(invocation.callId)) return { ok: false, code: "APPROVAL_INVALID", reason: "call not covered by approval" };
    const idx = approval.callIds.indexOf(invocation.callId);
    if (approval.preparedDigests[idx] !== invocation.digest) return { ok: false, code: "POLICY_CHANGED", reason: "prepared invocation changed since approval" };
    return { ok: true };
  }

  async createInput(input: { runId: string; tenantId: string; subjectId: string; callId: string; question: string; responseSchema: JsonObject }): Promise<InputRequestRecord> {
    const record: InputRequestRecord = {
      requestId: newId("inp"),
      tenantId: input.tenantId,
      runId: input.runId,
      callId: input.callId,
      question: input.question,
      responseSchema: input.responseSchema,
      recipientScope: { tenantId: input.tenantId, subjectId: input.subjectId },
      expiresAt: isoAfter(this.opts.inputExpiryMs),
      status: "pending",
      createdAt: nowIso(),
    };
    return this.opts.persistence.createInputRequest(record);
  }

  async notifyInput(request: InputRequestRecord): Promise<void> {
    if (!this.opts.inputTransport) return;
    await this.opts.inputTransport.request({
      request,
      answer: (value, actor) => this.answer({ requestId: request.requestId, actor, value }).then(() => undefined),
    });
  }

  async answer(input: { requestId: string; actor: Actor; value: JsonValue }): Promise<InputRequestRecord> {
    const existing = await this.opts.persistence.getInputRequest(input.requestId);
    if (!existing) throw new SFieldError("NOT_FOUND", `input request ${input.requestId} not found`);
    if (existing.tenantId !== input.actor.tenantId || existing.recipientScope.subjectId !== input.actor.subjectId) {
      throw new SFieldError("ACCESS_DENIED", "actor is not the recipient of this question");
    }
    const now = nowIso();
    if (existing.status === "pending" && existing.expiresAt <= now) throw new SFieldError("APPROVAL_EXPIRED", `question ${existing.requestId} expired`);
    const result = sharedValidator().validate(existing.responseSchema, input.value);
    if (!result.ok) throw new SFieldError("INVALID_INPUT", `answer does not match the question schema: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    const { request, changed } = await this.opts.persistence.answerInput({ id: existing.requestId, actor: input.actor, value: input.value, now });
    if (changed) this.opts.onWakeup(request.runId, "input_answered");
    return request;
  }
}
