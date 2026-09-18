/** Host options, plugins, bindings, hooks, transports (§6, §23). */
import type { Actor, BindingIdentity, DataClassification, Effect, JsonObject, JsonSchema, JsonValue, Principal, PublicError } from "./common.js";
import type { ContextBlock } from "./context.js";
import type { MemoryIndex, MemoryRepository, NewMemoryItem } from "./memory.js";
import type { ModelBinding, ModelProvider, NeutralModelRequest } from "./model.js";
import type { ArtifactStore, ApprovalRecord, ApprovalView, DeploymentMode, ExecutionPersistence, InputRequestRecord } from "./persistence.js";
import type { RetrievalBinding, RetrievalTypeFactory } from "./retrieval.js";
import type { RunEvent } from "./runtime.js";
import type { ConnectionHandle, DefineToolInput, ToolAdapter, ToolDefinition, ToolResultView } from "./tool.js";

export interface SecretResolver {
  /** Resolves a secret reference to its value; never logged. */
  resolve(ref: { env: string } | { name: string }): Promise<string>;
  /** Validates that a reference can be resolved without returning the value. */
  inspect?(ref: { env: string } | { name: string }): Promise<{ present: boolean }>;
  /** Known values for output scrubbing (§18.3). */
  knownValues?(): string[];
}

export interface ConnectionResolver {
  identity: BindingIdentity;
  resolve(principal: Principal, tool: ToolDefinition): Promise<ConnectionHandle>;
}

export interface HostBindings {
  models?: Record<string, ModelBinding>;
  connections?: Record<string, ConnectionResolver>;
  retrieval?: Record<string, RetrievalBinding>;
}

export interface AuthorizationRequest {
  principal: Principal;
  action: string;
  resource: { type: string; id: string; bindingIdentity: BindingIdentity };
  argumentsDigest: string;
  agentId?: string;
  runId: string;
  effect: Effect;
}

export type AuthorizationDecision =
  | { decision: "allow"; evidenceId: string; expiresAt: string }
  | { decision: "deny"; code: string; reason: string };

export interface Authorizer {
  authorize(req: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface PrerequisiteRequest {
  principal: Principal;
  runId: string;
  callId: string;
  toolRef: string;
  action: string;
  resource: { type: string; id: string };
  inputs: JsonObject;
  argumentsDigest: string;
}

export type PrerequisiteResult =
  | { ok: true; evidenceId: string; expiresAt: string; sourceVersion?: string; evidence?: JsonObject }
  | { ok: false; code: string; reason: string };

export type PrerequisiteCheck = (req: PrerequisiteRequest) => Promise<PrerequisiteResult>;

export interface ApprovalTransport {
  /** Notifies the host; decisions arrive through sf.approvals.decide. */
  request(view: { approval: ApprovalRecord; views: ApprovalView[]; decide(decision: "approve" | "deny", actor: Actor, comment?: string): Promise<void> }): Promise<void>;
}

export interface InputTransport {
  request(view: { request: InputRequestRecord; answer(value: JsonValue, actor: Actor): Promise<void> }): Promise<void>;
}

export interface TelemetrySink {
  event?(name: string, attributes: Record<string, string | number | boolean>): void;
  metric?(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;
}

export type BindingKind = "model" | "connection" | "retrieval" | "secret" | "persistence" | "artifacts";

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: 1;
  coreCompatibility: string;
  buildDigest: string;
  configSchema?: JsonSchema;
  requires: Array<{ kind: BindingKind; name: string }>;
  /** Fields under extensions.<id> that may carry ${env:NAME}. */
  substitutableFields?: string[];
}

export interface Registrar {
  adapter(adapter: ToolAdapter): void;
  tool(tool: ToolDefinition | DefineToolInput): void;
  provider(provider: ModelProvider): void;
  retrievalType(factory: RetrievalTypeFactory): void;
  contextTransform(transform: ContextTransform): void;
}

export interface ContextTransform {
  id: string;
  kind: "deterministic" | "model";
  apply(blocks: ContextBlock[], opts: { budgetTokens: number }): Promise<{ blocks: ContextBlock[]; note?: string }>;
}

export interface PluginStartContext {
  config: JsonObject;
  bindings: HostBindings;
  secrets: SecretResolver;
  signal: AbortSignal;
}

export interface HealthCheck {
  ok: boolean;
  detail?: string;
}

export interface SFieldPlugin {
  manifest: PluginManifest;
  register(registrar: Registrar): void;
  start?(ctx: PluginStartContext): Promise<void>;
  health?(): Promise<HealthCheck>;
  stop?(ctx: { signal: AbortSignal }): Promise<void>;
}

export interface GovernanceOptions {
  requireApproved?: boolean;
  requireEval?: {
    suite: string;
    minPassRate: number;
    maxCostDeltaRatio?: number;
    maxLatencyDeltaRatio?: number;
    baseline: "current_approved" | { digest: string };
    evidenceMaxAgeSeconds?: number;
    requireLive?: boolean;
  };
  approvalStore?: ExecutionPersistence["lockApprovals"];
}

export interface HostLimits {
  maxExposedTools?: number;
  loopDetection?: { minWindow?: number; maxWindow?: number; allowDisable?: boolean; maxPollsPerRun?: number };
  budgets?: {
    subjectPeriodCostMicroUsd?: number;
    tenantPeriodCostMicroUsd?: number;
    period?: "day" | "month";
    timezone?: string;
  };
  approvalExpirySeconds?: number;
  inputExpirySeconds?: number;
  requestMaxBytes?: number;
  grants?: {
    /** Required for bounded_auto writes without approval (§9.1). */
    autonomousWrites?: boolean;
    parallelMutations?: boolean;
    /** Built-in interaction tools the host permits (§8.4). */
    interactionTools?: Array<"ask_user" | "memory.remember" | "memory.forget">;
    /** Restrict which tools any agent may use; absent means all registered. */
    tools?: string[];
    /** Allowed effects at the host surface. */
    effects?: Effect[];
  };
  concurrency?: { readsPerRun?: number; mutationsPerRun?: number; providerPerBinding?: number };
  memoryCaps?: { preferences?: number; facts?: number };
  eventRetention?: number;
  retention?: { conversationDays?: number; preferenceDays?: number; factDays?: number; idempotencyDays?: number };
  inlineResultLimitBytes?: number;
  modelViewLimitBytes?: number;
  /** Revoked tool refs or principals checked at dispatch (§14.3). */
  revocations?: { tools?: string[]; subjects?: string[] };
}

export type HookPoint = "prepareTool" | "afterToolView" | "beforeMemoryWrite" | "beforeModelDispatch" | "onEvent";

export interface RegisteredHook {
  id: string;
  point: HookPoint;
  timeoutMs: number;
  onFailure: "fail" | "ignore";
  seesProtectedContent: boolean;
  buildIdentity: string;
  prepareTool?(ctx: { toolRef: string; inputs: JsonObject; principal: Principal; runId: string }): Promise<{ inputs?: JsonObject } | void>;
  afterToolView?(ctx: { toolRef: string; view: ToolResultView; principal: Principal }): Promise<{ view?: ToolResultView } | void>;
  beforeMemoryWrite?(ctx: { item: NewMemoryItem; principal: Principal }): Promise<{ item?: NewMemoryItem; reject?: string } | void>;
  beforeModelDispatch?(ctx: { request: NeutralModelRequest; runId: string }): Promise<{ request?: NeutralModelRequest } | void>;
  onEvent?(event: RunEvent): Promise<void> | void;
}

export interface ConfigDocument {
  [key: string]: JsonValue;
}

export interface OverrideDocument {
  [key: string]: JsonValue;
}

export interface Verifier {
  id: string;
  kind: "validator" | "registry_tool" | "model_grader";
  /** For validator verifiers. */
  validate?(output: JsonValue, ctx: { runId: string; principal: Principal }): Promise<{ ok: boolean; reason?: string }>;
  toolRef?: string;
  graderModel?: string;
  graderInstructions?: string;
}

export interface SFieldOptions {
  config: string | ConfigDocument;
  overrides?: OverrideDocument[];
  preset?: "local" | "memory";
  deployment?: DeploymentMode;
  plugins?: SFieldPlugin[];
  bindings?: HostBindings;
  tools?: ToolDefinition[];
  persistence?: ExecutionPersistence;
  memory?: MemoryRepository;
  memoryIndex?: MemoryIndex;
  artifacts?: ArtifactStore;
  authorizer?: Authorizer;
  governance?: GovernanceOptions;
  approvals?: ApprovalTransport;
  input?: InputTransport;
  prerequisites?: Record<string, PrerequisiteCheck>;
  hooks?: RegisteredHook[];
  telemetry?: TelemetrySink;
  limits?: HostLimits;
  secrets?: SecretResolver;
  verifiers?: Record<string, Verifier>;
  /** Development presets inject this; hosts never need it. */
  devPrincipal?: Principal;
  /** Deployment namespace for exclusive ownership (durable_single). */
  namespace?: string;
  /** Environment for `${env:NAME}` substitution and env secret refs; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative config paths when `config` is a document. */
  configDir?: string;
  /** Disables the development-preset console banner (tests). */
  quiet?: boolean;
  /** Reconciliation bindings by name (§24 reconcile_binding). */
  reconciliation?: Record<string, (ctx: { principal: Principal; intent: JsonObject; callId: string }) => Promise<{ effect: "confirmed" | "none" | "unknown"; output?: JsonValue }>>;
}

export interface HealthReport {
  ok: boolean;
  preset?: string;
  deployment: DeploymentMode;
  configDigest: string;
  degraded: string[];
  plugins: Record<string, HealthCheck>;
  persistence: HealthCheck;
}

export interface StartupError extends PublicError {
  path?: string;
}
