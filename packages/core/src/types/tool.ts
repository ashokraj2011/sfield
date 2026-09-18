/** Tool registry and pipeline contracts (§8, §9). */
import type {
  ArtifactRef,
  BindingIdentity,
  DataClassification,
  Effect,
  ErrorCategory,
  JsonObject,
  JsonSchema,
  JsonValue,
  Principal,
  RetrySafety,
  ValueBinding,
} from "./common.js";
import type { ArtifactStore } from "./persistence.js";

export interface ToolPolicy {
  effect: Effect;
  action: string;
  classification: DataClassification;
  timeoutMs: number;
  maxAttempts: number;
  retrySafety: RetrySafety;
  maxOutputBytes: number;
  requiresApproval: boolean;
  costMicroUsd: number;
  prerequisite?: string;
  /** Read tools only: repeats spaced by the interval are polls, not loops (§14.7). */
  pollable?: { minIntervalMs: number };
  /** Required for parallel mutations (§14.2). */
  conflictKey?: ValueBinding;
}

export interface DeduplicationContract {
  keyLocation: { header: string } | { body_field: string } | { query: string };
  scope: string;
  retentionSeconds: number;
  payloadMismatch: "reject" | "ignore";
  reconcileBinding?: string;
}

export interface ToolResource {
  type: string;
  id: ValueBinding;
}

export interface ToolHandlerContext {
  principal: Principal;
  signal: AbortSignal;
  callId: string;
  attemptId: string;
  runId: string;
  agentId?: string;
  logger: { debug(msg: string, data?: JsonObject): void; info(msg: string, data?: JsonObject): void; warn(msg: string, data?: JsonObject): void };
}

export type ToolHandler = (inputs: JsonObject, ctx: ToolHandlerContext) => Promise<JsonValue> | JsonValue;

export type ToolSource = "config" | "bundle" | "registerTool" | "builtin" | "import";

/** Immutable id@version definition (§8.1). */
export interface ToolDefinition {
  id: string;
  version: string;
  /** `id@version` */
  ref: string;
  description: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  /** Explicit projection applied before output validation (§8.1). */
  outputSelect?: string[];
  adapter: string;
  connection?: string;
  operation?: JsonObject;
  handler?: ToolHandler;
  resource?: ToolResource;
  policy: ToolPolicy;
  deduplication?: DeduplicationContract;
  extensions?: JsonObject;
  source: ToolSource;
  /** Digest of the definition without handler/source (§8.1). */
  digest: string;
  /** Validation notes produced at registration, e.g. the default read resource (§9.1). */
  notes: string[];
  bundleId?: string;
  buildDigest?: string;
}

/** Input to defineTool / registerTool (§8.3, §8.6). camelCase options. */
export interface DefineToolInput {
  id: string;
  version: string;
  description: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  select?: string[];
  resource?: ToolResource;
  policy?: Partial<{
    effect: Effect;
    action: string;
    classification: DataClassification;
    timeoutMs: number;
    maxAttempts: number;
    retrySafety: RetrySafety;
    maxOutputBytes: number;
    requiresApproval: boolean;
    costMicroUsd: number;
    prerequisite: string;
    pollable: { minIntervalMs: number };
    conflictKey: ValueBinding;
  }>;
  /** Compact form of policy.action plus resource. */
  authorization?: { action: string; resource?: ToolResource };
  deduplication?: DeduplicationContract;
  handler: ToolHandler;
  extensions?: JsonObject;
}

/** A secret-free, fully resolved operation (§8.5). */
export interface PreparedOperation {
  adapter: string;
  /** Adapter-owned, secret-free, JSON-serializable operation description. Bound into the invocation digest. */
  operation: JsonObject;
  resource: { type: string; id: string };
  conflictKey?: string;
  /** Human-readable, policy-safe summary for approval views. */
  summary: JsonObject;
}

export interface ConnectionHandle {
  identity: BindingIdentity;
  /** Secret-free configuration visible to prepare(). */
  config: JsonObject;
  /** Private client/credential material, only for execute(). Resolved lazily. */
  material(): Promise<JsonObject>;
}

export interface PreparationContext {
  principal: Principal;
  runId: string;
  callId: string;
  agentId?: string;
  connection?: ConnectionHandle;
  /** Resolve a ValueBinding against the allowed reference roots. */
  resolve(binding: ValueBinding, field: string): JsonValue | undefined;
}

export interface AdapterExecutionContext {
  principal: Principal;
  signal: AbortSignal;
  attemptId: string;
  callId: string;
  runId: string;
  idempotencyKey?: string;
  maxOutputBytes: number;
  timeoutMs: number;
  connection?: ConnectionHandle;
  artifacts: ArtifactStore;
  /** Attempt number, starting at 1. */
  attempt: number;
}

export interface AdapterError {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  status?: number;
}

/** Separates payload validity from knowledge of whether the effect happened (§8.5). */
export interface AdapterResult {
  payload?: JsonValue;
  artifact?: ArtifactRef;
  /** Whether a payload was transported and parsed as declared. */
  payloadValid: boolean;
  effect: "not_started" | "none" | "confirmed" | "unknown";
  transport: { status?: number; durationMs: number; bytes: number };
  error?: AdapterError;
}

export interface ReconciliationContext {
  principal: Principal;
  signal: AbortSignal;
  callId: string;
  runId: string;
  idempotencyKey?: string;
  connection?: ConnectionHandle;
  intent: JsonObject;
}

export interface ReconcileResult {
  effect: "confirmed" | "none" | "unknown";
  output?: JsonValue;
  evidence?: JsonObject;
}

export interface ToolAdapter {
  id: string;
  operationSchema: JsonSchema;
  prepare(def: ToolDefinition, input: JsonObject, ctx: PreparationContext): Promise<PreparedOperation>;
  execute(op: PreparedOperation, ctx: AdapterExecutionContext): Promise<AdapterResult>;
  reconcile?(op: PreparedOperation, ctx: ReconciliationContext): Promise<ReconcileResult>;
}

export interface PreparedInvocation {
  callId: string;
  runId: string;
  principalIdentity: { tenantId: string; subjectId: string };
  toolRef: string;
  toolDigest: string;
  bindingIdentity: BindingIdentity;
  resource: { type: string; id: string };
  normalizedInputs: JsonObject;
  operation: PreparedOperation;
  effect: Effect;
  configDigest: string;
  prerequisiteEvidence: string[];
  digest: string;
}

export interface ToolResultError {
  code: string;
  category: ErrorCategory;
  message: string;
}

export interface ToolResult {
  callId: string;
  toolRef: string;
  status: "succeeded" | "failed" | "outcome_unknown";
  effect: "not_started" | "none" | "confirmed" | "unknown";
  output?: JsonValue;
  outputRef?: ArtifactRef;
  error?: ToolResultError;
  meta: { attempts: number; durationMs: number; bytes: number };
}

/** Model-facing view of a result; canonical result stays intact (§9.6). */
export interface ToolResultView {
  callId: string;
  content: JsonValue;
  partial: boolean;
  isError: boolean;
}

export interface ExposedTool {
  ref: string;
  alias: string;
  description: string;
  inputSchema: JsonSchema;
  effect: Effect;
  requiresApproval: boolean;
  tokens: number;
  builtin: boolean;
}
