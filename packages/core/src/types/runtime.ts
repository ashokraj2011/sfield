/** Agent runtime contracts (§14, §19). */
import type { JsonObject, JsonValue, PublicError } from "./common.js";
import type { NeutralMessage } from "./model.js";
import type { ToolResult } from "./tool.js";

export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "suspended"
  | "reconciliation_required"
  | "completed"
  | "refused"
  | "filtered"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed"
  | "budget_exhausted"
  | "verification_failed";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "refused",
  "filtered",
  "denied",
  "expired",
  "cancelled",
  "failed",
  "budget_exhausted",
  "verification_failed",
]);

export const SUSPENDED_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "waiting_approval",
  "waiting_input",
  "suspended",
  "reconciliation_required",
]);

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export interface EffectSummary {
  callId: string;
  toolRef: string;
  effect: "read" | "write" | "destructive";
  outcome: "none" | "confirmed" | "unknown" | "not_started";
  resource: { type: string; id: string };
  outputRef?: string;
}

export interface UsageSummary {
  turns: number;
  modelCalls: number;
  providerAttempts: number;
  toolCalls: number;
  toolAttempts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Whether token totals are reported (true) or include estimates (false). */
  tokensReported: boolean;
  costMicroUsd: number;
  costLabel: "priced" | "best_effort" | "unpriced";
  activeMs: number;
  elapsedMs: number;
}

export interface RunResult {
  runId: string;
  state: RunState;
  output?: JsonValue;
  pending?: { approvals: string[]; inputs: string[] };
  effects: EffectSummary[];
  usage: UsageSummary;
  error?: PublicError;
  citations?: Record<string, { label: string; uri?: string; locator?: string }>;
}

export interface RunEvent {
  v: 1;
  id: string;
  runId: string;
  conversationId?: string;
  timestamp: string;
  type: string;
  payload: JsonObject;
  /** Per-run monotonic sequence for durable events; absent for provisional events. */
  seq?: number;
  provisional?: boolean;
}

export interface RunSnapshot {
  runId: string;
  conversationId?: string;
  agentId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  configDigest: string;
  output?: JsonValue;
  pending?: { approvals: string[]; inputs: string[] };
  effects: EffectSummary[];
  usage: UsageSummary;
  error?: PublicError;
  calls: Array<{ callId: string; toolRef: string; state: string; effect: string; status?: string }>;
  lastEventSeq: number;
}

export interface RunHandle {
  readonly id: string;
  readonly idempotencyKey: string;
  events(opts?: { after?: string }): AsyncIterable<RunEvent>;
  snapshot(): Promise<RunSnapshot>;
  result(): Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

export interface Session {
  readonly id: string;
  readonly conversationId: string;
  readonly agentId: string;
  send(request: import("./common.js").SendRequest): Promise<RunHandle>;
  close(): Promise<void>;
}

export type CallState =
  | "proposed"
  | "prepared"
  | "waiting_approval"
  | "ready"
  | "intent_committed"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "rejected";

export interface RunCounters {
  turns: number;
  modelCalls: number;
  providerAttempts: number;
  toolCalls: number;
  toolAttempts: number;
  inputTokens: number;
  outputTokens: number;
  tokensReported: boolean;
  costMicroUsd: number;
  costLabel: UsageSummary["costLabel"];
  activeMs: number;
  repairs: number;
  summarizations: number;
  polls: number;
  contextRefits: number;
  continuations: number;
}

export interface LoopDetectorState {
  /** identity -> [{turn, callId}] */
  seen: Record<string, Array<{ turn: number; callId: string; at: string }>>;
  warned: Record<string, number>;
  pollCount: number;
}

/** Durable continuation state (§17.4). Never contains secrets or sockets. */
export interface Checkpoint {
  runId: string;
  conversationId?: string;
  agentId: string;
  configDigest: string;
  pluginIdentities: Record<string, string>;
  /** Prior conversation history (before this run's message). */
  transcript: NeutralMessage[];
  /** This run's own messages after the current user message: assistant turns, result batches, repair prompts. */
  runMessages: NeutralMessage[];
  contextPacketIds: string[];
  pendingBatch?: { batchId: string; callIds: string[]; turn: number };
  pendingApprovals: string[];
  pendingInputs: string[];
  reservationIds: string[];
  counters: RunCounters;
  loop: LoopDetectorState;
  /** Tool results already committed for the pending batch, by callId. */
  batchResults: Record<string, ToolResult>;
  continuation?: { reason: "approval" | "input" | "reconciliation" | "suspend"; since: string; note?: string };
  startedAt: string;
  suspendedAt?: string;
  updatedAt: string;
}
