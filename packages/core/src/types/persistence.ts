/** Persistence domain contract (§17). */
import type { Actor, ArtifactRef, DataClassification, JsonObject, JsonValue, Principal, PublicError, SendRequest } from "./common.js";
import type { ContextExplanation } from "./context.js";
import type { MemoryRepository } from "./memory.js";
import type { ModelAttemptRecord } from "./model.js";
import type { CallState, Checkpoint, EffectSummary, RunEvent, RunState, UsageSummary } from "./runtime.js";
import type { PreparedInvocation, ToolResult } from "./tool.js";

export type DeploymentMode = "ephemeral" | "durable_single" | "service";

export interface ArtifactStore {
  put(input: { bytes: Uint8Array; mediaType: string; classification: DataClassification; tenantId: string; runId?: string }): Promise<ArtifactRef>;
  get(ref: ArtifactRef, opts: { tenantId: string; maxBytes: number }): Promise<Uint8Array>;
  delete(ref: ArtifactRef, opts: { tenantId: string }): Promise<void>;
  /** Marks a reference committed under current ownership; uncommitted uploads may be garbage-collected. */
  commit?(ref: ArtifactRef, opts: { tenantId: string; runId?: string }): Promise<void>;
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  subjectId: string;
  /** Host-authenticated principal captured at the boundary; used for in-process resumption. */
  principal: Principal;
  agentId: string;
  conversationId?: string;
  kind: "session" | "standalone" | "external";
  /** Ownership scope: the conversation for session runs, the run itself otherwise (§17.3). */
  scopeId: string;
  state: RunState;
  request: SendRequest;
  requestDigest: string;
  idempotencyKey: string;
  idempotencyScope: string;
  configDigest: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ownerId?: string;
  epoch: number;
  leaseExpiresAt?: string;
  output?: JsonValue;
  error?: PublicError;
  effects: EffectSummary[];
  usage: UsageSummary;
  pending: { approvals: string[]; inputs: string[] };
  lastEventSeq: number;
  preset?: string;
  cancelRequested?: { at: string; reason?: string } | null;
  wakeup?: { at: string; reason: string } | null;
  citations?: Record<string, { label: string; uri?: string; locator?: string }>;
}

export interface CallRecord {
  callId: string;
  runId: string;
  batchId: string;
  turn: number;
  order: number;
  toolRef: string;
  state: CallState;
  proposedArguments: JsonObject;
  providerCallId?: string;
  invocation?: PreparedInvocation;
  approvalId?: string;
  intent?: { at: string; idempotencyKey?: string; attempt: number; operationDigest: string };
  result?: ToolResult;
  attempts: Array<{ attemptId: string; at: string; durationMs: number; outcome: string; error?: string }>;
  reservationId?: string;
  createdAt: string;
  updatedAt: string;
  lateObservations?: Array<{ at: string; observation: JsonObject; actor?: string }>;
}

export interface ApprovalView {
  action: string;
  toolRef: string;
  effect: string;
  resource: { type: string; id: string };
  summary: JsonObject;
  arguments: JsonObject;
  amount?: { value: number; currency: string; unit: "minor" };
  artifactDigests: string[];
  agentId: string;
  requester: { tenantId: string; subjectId: string };
  preset?: string;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  runId: string;
  callIds: string[];
  preparedDigests: string[];
  requesterSubjectId: string;
  allowedApproverPolicyId: string;
  view: ApprovalView[];
  expiresAt: string;
  maxUses: 1;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  decision?: { actor: Actor; decision: "approve" | "deny"; comment?: string; decidedAt: string };
  createdAt: string;
  consumedAt?: string;
}

export interface InputRequestRecord {
  requestId: string;
  tenantId: string;
  runId: string;
  callId: string;
  question: string;
  responseSchema: JsonObject;
  recipientScope: { tenantId: string; subjectId: string };
  expiresAt: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  answer?: { actor: Actor; value: JsonValue; answeredAt: string };
  createdAt: string;
}

export type ReservationState = "held" | "dispatched" | "settled" | "uncertain" | "released";

export interface ReservationRecord {
  id: string;
  parentId?: string;
  runId: string;
  tenantId: string;
  subjectId: string;
  kind: "model" | "tool" | "allocation";
  callId?: string;
  attemptId?: string;
  estimateMicroUsd: number;
  estimateTokens?: number;
  actualMicroUsd?: number;
  priceVersion?: string;
  state: ReservationState;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BudgetScopeRequest {
  /** Structured key, e.g. ["run", runId], ["subject", tenant, subject, period], ["tenant", tenant, period]. */
  key: string;
  ceilingMicroUsd: number;
}

export interface AuditRecord {
  id: string;
  at: string;
  tenantId: string;
  runId?: string;
  callId?: string;
  type: string;
  principal?: { tenantId: string; subjectId: string };
  configDigest?: string;
  data: JsonObject;
  preset?: string;
}

export interface ConversationRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  deletedAt?: string;
  messageCount: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  tenantId: string;
  runId?: string;
  index: number;
  role: "user" | "assistant" | "tool_results" | "summary";
  content: JsonValue;
  createdAt: string;
  expiresAt: string;
}

export interface LockApprovalRecord {
  digest: string;
  approver: string;
  decidedAt: string;
  comment?: string;
  evalReportId?: string;
  suite?: string;
  noBaseline?: boolean;
}

export interface EvalReportRecord {
  id: string;
  suite: string;
  datasetVersion: string;
  candidateDigest: string;
  baselineDigest?: string;
  modelTargets: string[];
  mode: "replay" | "live";
  passRate: number;
  verifiedSuccessRate: number;
  costDeltaRatio?: number;
  latencyDeltaRatio?: number;
  cases: ArtifactRef | { inline: JsonValue };
  createdAt: string;
  expiresAt: string;
}

export interface OwnershipClaim {
  scopeId: string;
  ownerId: string;
  epoch: number;
  expiresAt: string;
}

export interface AcceptRequestInput {
  run: Omit<RunRecord, "epoch" | "lastEventSeq" | "updatedAt" | "createdAt"> & { createdAt?: string };
  message?: Omit<MessageRecord, "index" | "id">;
  /** Idempotency retention in ms. */
  retentionMs: number;
}

export interface AcceptRequestResult {
  run: RunRecord;
  created: boolean;
}

export interface CommitResultInput {
  runId: string;
  epoch: number;
  callId: string;
  result: ToolResult;
  state: CallState;
  reservation?: { id: string; actualMicroUsd: number; state: ReservationState };
  events: RunEvent[];
  audit?: AuditRecord[];
  attempt?: CallRecord["attempts"][number];
}

/** Domain persistence contract (§17.2). Implementations must satisfy the conformance suite. */
export interface ExecutionPersistence {
  readonly mode: DeploymentMode;
  init(ctx: { namespace: string; ownerId: string }): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;

  acceptRequest(input: AcceptRequestInput): Promise<AcceptRequestResult>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(filter: { tenantId?: string; conversationId?: string; state?: RunState[]; limit?: number }): Promise<RunRecord[]>;
  updateRun(runId: string, epoch: number, patch: Partial<RunRecord>): Promise<RunRecord>;
  /** Wake-ups are recorded by decisions; the scheduler claims them. */
  listWakeups(): Promise<RunRecord[]>;
  /** Records a cancellation request without ownership; the owner honors it at the next boundary (§14.6). */
  requestCancel(runId: string, reason?: string): Promise<void>;

  claim(scopeId: string, ownerId: string, leaseMs: number): Promise<OwnershipClaim | null>;
  renew(claim: OwnershipClaim, leaseMs: number): Promise<OwnershipClaim | null>;
  release(claim: OwnershipClaim): Promise<void>;
  currentOwner(scopeId: string): Promise<OwnershipClaim | null>;

  createConversation(rec: ConversationRecord): Promise<ConversationRecord>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  /** Atomically sets the active run; returns false when another run is active. */
  setActiveRun(conversationId: string, runId: string | null, expectedActive?: string | null): Promise<boolean>;
  appendMessage(msg: Omit<MessageRecord, "index" | "id"> & { id?: string }): Promise<MessageRecord>;
  listMessages(conversationId: string, opts: { limit?: number; before?: number; includeExpired?: boolean }): Promise<MessageRecord[]>;
  deleteConversation(id: string): Promise<{ messages: number }>;

  prepareBatch(runId: string, epoch: number, calls: CallRecord[]): Promise<void>;
  getCall(callId: string): Promise<CallRecord | null>;
  listCalls(runId: string): Promise<CallRecord[]>;
  updateCall(runId: string, epoch: number, callId: string, patch: Partial<CallRecord>): Promise<CallRecord>;
  /** Checks ownership, approval, call state; reserves all budget scopes atomically. */
  authorizeDispatch(input: {
    runId: string;
    epoch: number;
    callId: string;
    approvalId?: string;
    reservation: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">;
    scopes: BudgetScopeRequest[];
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }>;
  recordIntent(runId: string, epoch: number, callId: string, intent: NonNullable<CallRecord["intent"]>): Promise<void>;
  commitResult(input: CommitResultInput): Promise<void>;
  recordLateObservation(callId: string, observation: JsonObject, actor?: string): Promise<void>;

  createApproval(rec: ApprovalRecord): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  listApprovals(filter: { tenantId?: string; runId?: string; status?: ApprovalRecord["status"][] }): Promise<ApprovalRecord[]>;
  /** Commits one decision plus the wake-up intent; idempotent on same decision, APPROVAL_ALREADY_DECIDED otherwise. */
  decideApproval(input: { id: string; actor: Actor; decision: "approve" | "deny"; comment?: string; now: string }): Promise<{ approval: ApprovalRecord; changed: boolean }>;
  consumeApproval(id: string, runId: string, epoch: number): Promise<ApprovalRecord>;

  createInputRequest(rec: InputRequestRecord): Promise<InputRequestRecord>;
  getInputRequest(id: string): Promise<InputRequestRecord | null>;
  listInputRequests(filter: { tenantId?: string; runId?: string; status?: InputRequestRecord["status"][] }): Promise<InputRequestRecord[]>;
  answerInput(input: { id: string; actor: Actor; value: JsonValue; now: string }): Promise<{ request: InputRequestRecord; changed: boolean }>;

  saveCheckpoint(runId: string, epoch: number, checkpoint: Checkpoint): Promise<void>;
  getCheckpoint(runId: string): Promise<Checkpoint | null>;

  appendEvents(runId: string, epoch: number | null, events: RunEvent[]): Promise<RunEvent[]>;
  readEvents(runId: string, afterSeq: number, limit?: number): Promise<{ events: RunEvent[]; gap: boolean; lastSeq: number }>;

  appendAudit(records: AuditRecord[]): Promise<void>;
  readAudit(filter: { tenantId?: string; runId?: string; type?: string; limit?: number }): Promise<AuditRecord[]>;

  reserve(input: Omit<ReservationRecord, "id" | "state" | "createdAt" | "updatedAt">, scopes: BudgetScopeRequest[]): Promise<{ ok: true; id: string } | { ok: false; code: string; reason: string }>;
  settle(id: string, actualMicroUsd: number, state: Exclude<ReservationState, "held">): Promise<void>;
  getReservation(id: string): Promise<ReservationRecord | null>;
  scopeUsage(scopeKey: string): Promise<{ heldMicroUsd: number; settledMicroUsd: number }>;

  recordModelAttempt(runId: string, rec: ModelAttemptRecord): Promise<void>;
  listModelAttempts(runId: string): Promise<ModelAttemptRecord[]>;

  saveContextExplanation(rec: ContextExplanation): Promise<void>;
  getContextExplanation(id: string): Promise<ContextExplanation | null>;

  lockApprovals: {
    get(digest: string): Promise<LockApprovalRecord | null>;
    put(rec: LockApprovalRecord): Promise<{ record: LockApprovalRecord; changed: boolean }>;
    latest(suite?: string): Promise<LockApprovalRecord | null>;
  };
  evalReports: {
    get(id: string): Promise<EvalReportRecord | null>;
    put(rec: EvalReportRecord): Promise<void>;
    list(filter: { suite?: string; candidateDigest?: string }): Promise<EvalReportRecord[]>;
  };

  /** Default memory repository supplied by the persistence package (§17.5). */
  memory?: MemoryRepository;
  artifacts?: ArtifactStore;
}
