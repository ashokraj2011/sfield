/** The one tool pipeline (§9.3). Built-in and custom tools share validation, authorization, approvals, budgeting, results, and records. */
import type { DataClassification, JsonObject, JsonValue, Principal, ValueBinding } from "../types/common.js";
import { maxClassification } from "../types/common.js";
import type { Authorizer, ConnectionResolver, HostLimits, PrerequisiteCheck, RegisteredHook, TelemetrySink } from "../types/options.js";
import type { ApprovalView, ArtifactStore, AuditRecord, BudgetScopeRequest, CallRecord, ExecutionPersistence } from "../types/persistence.js";
import type { RunEvent, CallState } from "../types/runtime.js";
import type { AdapterResult, ConnectionHandle, PreparedInvocation, PreparedOperation, ToolDefinition, ToolResult, ToolResultView } from "../types/tool.js";
import { SFieldError, sanitizeMessage } from "../errors.js";
import { sharedValidator } from "../schema/validator.js";
import { applySelect } from "../schema/select.js";
import { digestJson, newId, nowIso, sha256Hex } from "../util/digest.js";
import { OMIT, resolveBinding } from "../util/refs.js";
import { withTimeout } from "../util/async.js";
import type { Scrubber } from "../util/scrub.js";
import type { ToolRegistry } from "../registry/registry.js";
import { approvalRequired, effectAllowed, type PolicyPreset } from "../policy/presets.js";
import type { ApprovalService } from "../policy/approvals.js";
import { jsonBytes, shortenForModel } from "./views.js";

export type ReconcileFn = (ctx: { principal: Principal; intent: JsonObject; callId: string }) => Promise<{ effect: "confirmed" | "none" | "unknown"; output?: JsonValue }>;

export type BuiltinExecutor = (def: ToolDefinition, inputs: JsonObject, ctx: { principal: Principal; runId: string; callId: string; signal: AbortSignal }) => Promise<AdapterResult>;

export interface PipelineDeps {
  registry: ToolRegistry;
  persistence: ExecutionPersistence;
  authorizer: Authorizer;
  approvals: ApprovalService;
  prerequisites: Record<string, PrerequisiteCheck>;
  hooks: RegisteredHook[];
  limits: HostLimits;
  connections: Record<string, ConnectionResolver>;
  artifacts: ArtifactStore;
  configDigest: string;
  scrubber: Scrubber;
  reconciliation: Record<string, ReconcileFn>;
  preset?: string;
  telemetry?: TelemetrySink;
  builtinExecutor?: BuiltinExecutor;
  inlineResultLimitBytes: number;
  modelViewLimitBytes: number;
}

export interface PrepareRequest {
  def: ToolDefinition;
  inputs: JsonObject;
  principal: Principal;
  runId: string;
  callId: string;
  agentId?: string;
  preset: PolicyPreset;
  /** The run's pinned configuration digest (defaults to the current one). */
  configDigest?: string;
  /** Connection resolvers of the run's pinned configuration version. */
  connections?: Record<string, ConnectionResolver>;
}

export interface PreparedCall {
  def: ToolDefinition;
  invocation: PreparedInvocation;
  normalizedInputs: JsonObject;
  defaultsInserted: string[];
  approval: { required: boolean; reason: string };
  view: ApprovalView;
  evidence: Array<{ kind: "authorization" | "prerequisite"; id: string; expiresAt: string }>;
  connection?: ConnectionHandle;
  classification: DataClassification;
}

export interface DispatchRequest {
  prepared: PreparedCall;
  principal: Principal;
  runId: string;
  epoch: number;
  agentId?: string;
  conversationId?: string;
  approvalId?: string;
  signal: AbortSignal;
  budgetScopes: BudgetScopeRequest[];
  connections?: Record<string, ConnectionResolver>;
  /** Emits committed durable events to live subscribers. */
  onEvents?: (events: RunEvent[]) => void;
}

export interface DispatchOutcome {
  result: ToolResult;
  view: ToolResultView;
  state: CallState;
}

export class ToolPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** Steps 1–6: validate, hooks, prepare, authorize, prerequisites, prepared invocation, approval requirement. */
  async prepare(req: PrepareRequest): Promise<PreparedCall> {
    const { def, principal, runId, callId } = req;
    const limits = this.deps.limits;
    if (limits.revocations?.tools?.includes(def.ref) || limits.revocations?.tools?.includes(def.id)) {
      throw new SFieldError("REVOKED", `tool ${def.ref} is revoked`, { runId, callId });
    }
    if (limits.revocations?.subjects?.includes(principal.subjectId)) throw new SFieldError("REVOKED", "subject access revoked", { runId, callId });
    const validator = sharedValidator();

    // 2. Validate inputs; apply declared defaults (recorded).
    const { value: defaulted, inserted } = validator.applyDefaults(def.inputs, req.inputs);
    let inputs = defaulted as JsonObject;
    const v1 = validator.validate(def.inputs, inputs);
    if (!v1.ok) {
      throw new SFieldError("INVALID_INPUT", `invalid arguments for ${def.ref}: ${v1.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { runId, callId, details: { errors: v1.errors.map((e) => `${e.path}: ${e.message}`) } });
    }

    // 3. Preparation hooks may propose input changes; revalidate any mutation.
    for (const hook of this.deps.hooks) {
      if (hook.point !== "prepareTool" || !hook.prepareTool) continue;
      try {
        const res = await withTimeout(hook.timeoutMs, () => hook.prepareTool!({ toolRef: def.ref, inputs, principal, runId }), { label: `hook ${hook.id}` });
        if (res?.inputs) {
          const v2 = validator.validate(def.inputs, res.inputs);
          if (!v2.ok) throw new SFieldError("INVALID_INPUT", `hook ${hook.id} produced invalid arguments: ${v2.errors.map((e) => e.message).join("; ")}`, { runId, callId });
          inputs = res.inputs;
        }
      } catch (e) {
        if (SFieldError.is(e)) throw e;
        if (hook.onFailure === "fail") throw new SFieldError("HOOK_TIMEOUT", `hook ${hook.id} failed: ${(e as Error).message}`, { runId, callId });
      }
    }

    // 4. Secret-free operation and concrete resource.
    const adapter = def.adapter === "builtin" ? this.deps.registry.functionAdapter : this.deps.registry.getAdapter(def.adapter);
    if (!adapter) throw new SFieldError("UNKNOWN_ADAPTER", `adapter ${def.adapter} is not registered`, { runId, callId });
    let connection: ConnectionHandle | undefined;
    const connections = req.connections ?? this.deps.connections;
    if (def.connection) {
      const resolver = connections[def.connection];
      if (!resolver) throw new SFieldError("UNKNOWN_BINDING", `connection ${def.connection} is not bound`, { runId, callId });
      connection = await resolver.resolve(principal, def);
    }
    const roots = { inputs };
    const resolve = (binding: ValueBinding, field: string): JsonValue | undefined => {
      const v = resolveBinding(binding, roots, { field, allowOmit: true, allowedRoots: ["inputs"] });
      return v === OMIT ? undefined : v;
    };
    let operation: PreparedOperation;
    try {
      operation = await adapter.prepare(def, inputs, { principal, runId, callId, agentId: req.agentId, connection, resolve });
    } catch (e) {
      if (SFieldError.is(e)) throw e;
      throw new SFieldError("INVALID_INPUT", `cannot prepare ${def.ref}: ${sanitizeMessage((e as Error).message)}`, { runId, callId });
    }
    const effect = def.policy.effect;
    const bindingIdentity = connection?.identity ?? { id: `adapter:${def.adapter}`, revision: def.digest.slice(7, 19), accountScope: principal.tenantId, classification: def.policy.classification };
    const classification = connection ? maxClassification(def.policy.classification, connection.identity.classification) : def.policy.classification;

    // 5. Host and agent permissions, resource authorization, prerequisites, data routing.
    if (!effectAllowed(req.preset, effect)) throw new SFieldError("EFFECT_NOT_ALLOWED", `preset ${req.preset} does not permit ${effect} tools`, { runId, callId });
    if (limits.grants?.effects && !limits.grants.effects.includes(effect)) throw new SFieldError("EFFECT_NOT_ALLOWED", `host does not grant ${effect} effects`, { runId, callId });
    const argumentsDigest = digestJson(inputs);
    const evidence: PreparedCall["evidence"] = [];
    const decision = await this.deps.authorizer.authorize({ principal, action: def.policy.action, resource: { ...operation.resource, bindingIdentity }, argumentsDigest, agentId: req.agentId, runId, effect });
    if (decision.decision !== "allow") throw new SFieldError("ACCESS_DENIED", `${def.policy.action} on ${operation.resource.type}:${operation.resource.id} denied: ${decision.reason}`, { runId, callId, details: { code: decision.code } });
    evidence.push({ kind: "authorization", id: decision.evidenceId, expiresAt: decision.expiresAt });
    if (def.policy.prerequisite) {
      const check = this.deps.prerequisites[def.policy.prerequisite];
      if (!check) throw new SFieldError("UNKNOWN_BINDING", `prerequisite ${def.policy.prerequisite} is not registered`, { runId, callId });
      const pre = await check({ principal, runId, callId, toolRef: def.ref, action: def.policy.action, resource: operation.resource, inputs, argumentsDigest });
      if (!pre.ok) throw new SFieldError("PREREQUISITE_FAILED", `prerequisite ${def.policy.prerequisite} failed: ${pre.reason}`, { runId, callId, details: { code: pre.code } });
      evidence.push({ kind: "prerequisite", id: pre.evidenceId, expiresAt: pre.expiresAt });
    }

    // 6. Immutable prepared invocation; digest binds normalized values and evidence identities, not expiry timestamps.
    const base = {
      callId,
      runId,
      principalIdentity: { tenantId: principal.tenantId, subjectId: principal.subjectId },
      toolRef: def.ref,
      toolDigest: def.digest,
      bindingIdentity,
      resource: operation.resource,
      normalizedInputs: inputs,
      operation,
      effect,
      configDigest: req.configDigest ?? this.deps.configDigest,
      prerequisiteEvidence: evidence.map((e) => e.id),
    };
    const invocation: PreparedInvocation = { ...base, digest: digestJson(base) };
    const approval = approvalRequired(req.preset, def, limits);
    const view: ApprovalView = {
      action: def.policy.action,
      toolRef: def.ref,
      effect,
      resource: operation.resource,
      summary: this.deps.scrubber.scrubValue(operation.summary) as JsonObject,
      arguments: this.deps.scrubber.scrubValue(inputs) as JsonObject,
      artifactDigests: [],
      agentId: req.agentId ?? "",
      requester: { tenantId: principal.tenantId, subjectId: principal.subjectId },
    };
    if (this.deps.preset) view.preset = this.deps.preset;
    const amount = amountOf(inputs);
    if (amount) view.amount = amount;
    await this.deps.persistence.appendAudit([
      this.audit(principal, runId, callId, "tool_prepared", { toolRef: def.ref, invocationDigest: invocation.digest, resource: operation.resource, effect, approvalRequired: approval.required, approvalReason: approval.reason, evidence: evidence.map((e) => ({ kind: e.kind, id: e.id })), defaultsInserted: inserted }),
    ]);
    const out: PreparedCall = { def, invocation, normalizedInputs: inputs, defaultsInserted: inserted, approval, view, evidence, classification };
    if (connection) out.connection = connection;
    return out;
  }

  /** Steps 7–10: reserve, recheck, record intent, dispatch, observe, validate, store, commit. */
  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    const { prepared, principal, runId, epoch } = req;
    const { def, invocation } = prepared;
    const callId = invocation.callId;
    const p = this.deps.persistence;
    const started = Date.now();

    // 7. Atomic claim + budget reservation, then recheck authorization, revocation, binding identity, approval.
    const reservation = { runId, tenantId: principal.tenantId, subjectId: principal.subjectId, kind: "tool" as const, callId, estimateMicroUsd: def.policy.costMicroUsd, scopes: req.budgetScopes.map((s) => s.key) };
    const authz = await p.authorizeDispatch({ runId, epoch, callId, approvalId: req.approvalId, reservation, scopes: req.budgetScopes });
    if (!authz.ok) return this.rejected(req, authz.code, authz.reason, started);
    const reservationId = authz.reservationId;
    const revoked = this.deps.limits.revocations;
    if (revoked?.tools?.includes(def.ref) || revoked?.subjects?.includes(principal.subjectId)) {
      await p.settle(reservationId, 0, "released");
      return this.rejected(req, "REVOKED", "revoked before dispatch", started);
    }
    if (req.approvalId) {
      const approval = await p.getApproval(req.approvalId);
      const valid = this.deps.approvals.validate(approval, invocation);
      if (!valid.ok) {
        await p.settle(reservationId, 0, "released");
        return this.rejected(req, valid.code, valid.reason, started);
      }
    } else if (prepared.approval.required) {
      await p.settle(reservationId, 0, "released");
      return this.rejected(req, "APPROVAL_REQUIRED", prepared.approval.reason, started);
    }
    if (prepared.connection && def.connection) {
      const fresh = await (req.connections ?? this.deps.connections)[def.connection]?.resolve(principal, def);
      if (!fresh || fresh.identity.id !== invocation.bindingIdentity.id || fresh.identity.accountScope !== invocation.bindingIdentity.accountScope) {
        await p.settle(reservationId, 0, "released");
        return this.rejected(req, "POLICY_CHANGED", "connection binding changed since preparation", started);
      }
    }
    const now = nowIso();
    if (prepared.evidence.some((e) => e.expiresAt <= now)) {
      // Refresh expired evidence for the same operation; a changed decision fails closed (§9.4).
      const again = await this.deps.authorizer.authorize({ principal, action: def.policy.action, resource: { ...invocation.resource, bindingIdentity: invocation.bindingIdentity }, argumentsDigest: digestJson(invocation.normalizedInputs), agentId: req.agentId, runId, effect: invocation.effect });
      if (again.decision !== "allow") {
        await p.settle(reservationId, 0, "released");
        return this.rejected(req, "EVIDENCE_EXPIRED", `authorization could not be refreshed: ${again.reason}`, started);
      }
    }
    if (req.approvalId) await p.consumeApproval(req.approvalId, runId, epoch);

    // 8. Durable dispatch intent, then dispatch.
    const idempotencyKey = def.deduplication ? sha256Hex(JSON.stringify([principal.tenantId, invocation.bindingIdentity.accountScope, runId, callId, digestJson(invocation.operation.operation)])) : undefined;
    const intent: NonNullable<CallRecord["intent"]> = { at: now, attempt: 1, operationDigest: digestJson(invocation.operation.operation) };
    if (idempotencyKey) intent.idempotencyKey = idempotencyKey;
    await p.recordIntent(runId, epoch, callId, intent);
    const startedEvents = await p.appendEvents(runId, epoch, [this.event(runId, req.conversationId, "tool_started", { callId, toolRef: def.ref, effect: def.policy.effect, resource: invocation.resource })]);
    req.onEvents?.(startedEvents);
    await p.appendAudit([this.audit(principal, runId, callId, "tool_dispatch_intent", { toolRef: def.ref, invocationDigest: invocation.digest, idempotencyKey: idempotencyKey ?? null, reservationId })]);

    const attempts: CallRecord["attempts"] = [];
    let adapterResult: AdapterResult | undefined;
    const maxAttempts = Math.max(1, def.policy.maxAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptId = newId("att");
      const t0 = Date.now();
      const ctx = { principal, signal: req.signal, attemptId, callId, runId, idempotencyKey, maxOutputBytes: def.policy.maxOutputBytes, timeoutMs: def.policy.timeoutMs, connection: prepared.connection, artifacts: this.deps.artifacts, attempt };
      try {
        if (def.adapter === "builtin") {
          if (!this.deps.builtinExecutor) throw new SFieldError("TOOL_UNAVAILABLE", "built-in tools need a runtime executor");
          adapterResult = await this.deps.builtinExecutor(def, invocation.normalizedInputs, { principal, runId, callId, signal: req.signal });
        } else if (def.adapter === "function") {
          adapterResult = await this.deps.registry.functionAdapter.execute(invocation.operation, ctx, invocation.normalizedInputs);
        } else {
          adapterResult = await this.deps.registry.getAdapter(def.adapter)!.execute(invocation.operation, ctx);
        }
      } catch (e) {
        adapterResult = { payloadValid: false, effect: def.policy.effect === "read" ? "none" : "unknown", transport: { durationMs: Date.now() - t0, bytes: 0 }, error: { code: SFieldError.is(e) ? e.code : "TOOL_ERROR", category: "internal", message: sanitizeMessage(e instanceof Error ? e.message : String(e)), retryable: false } };
      }
      const outcome = adapterResult.error ? `error:${adapterResult.error.code}` : "ok";
      attempts.push({ attemptId, at: new Date(t0).toISOString(), durationMs: Date.now() - t0, outcome, error: adapterResult.error ? this.deps.scrubber.scrubText(adapterResult.error.message) : undefined });
      if (!adapterResult.error || attempt >= maxAttempts || req.signal.aborted) break;
      if (!adapterResult.error.retryable) break;
      const safe = def.policy.retrySafety === "repeatable" || def.policy.retrySafety === "deduplicated" || adapterResult.effect === "not_started";
      if (!safe) break;
    }
    const observed = adapterResult!;

    // 9. Observe effect and transport, validate the business output, store canonical result, produce views.
    const effect: ToolResult["effect"] = def.policy.effect === "read" ? (observed.effect === "not_started" ? "not_started" : "none") : observed.effect;
    let status: ToolResult["status"];
    let output: JsonValue | undefined;
    let outputRef: ToolResult["outputRef"];
    let error: ToolResult["error"];
    if (observed.error) {
      status = effect === "unknown" ? "outcome_unknown" : "failed";
      error = { code: observed.error.code, category: observed.error.category, message: this.deps.scrubber.scrubText(observed.error.message) };
    } else if (observed.artifact) {
      status = "succeeded";
      outputRef = observed.artifact;
      // Adapter-produced artifacts are committed under current ownership so GC never drops a referenced result (§17.4).
      await this.deps.artifacts.commit?.(observed.artifact, { tenantId: principal.tenantId, runId });
      output = { artifact_id: observed.artifact.id, digest: observed.artifact.digest, bytes: observed.artifact.bytes, media_type: observed.artifact.mediaType };
      const v = sharedValidator().validate(def.outputs, output);
      if (!v.ok) {
        status = "failed";
        error = { code: "INVALID_OUTPUT", category: "validation", message: `artifact result does not match the declared outputs: ${v.errors.map((e) => e.message).join("; ")}` };
      }
    } else {
      let candidate = observed.payload === undefined ? null : observed.payload;
      if (def.outputSelect) candidate = applySelect(candidate, def.outputSelect);
      const v = sharedValidator().validate(def.outputs, candidate);
      if (v.ok) {
        status = "succeeded";
        output = candidate;
      } else {
        // The effect stands: a mutation that returned invalid JSON is still a confirmed mutation (§9.6).
        status = "failed";
        error = { code: "INVALID_OUTPUT", category: "validation", message: `output does not match the declared schema: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}` };
        output = candidate;
      }
    }
    if (output !== undefined && !outputRef && jsonBytes(output) > this.deps.inlineResultLimitBytes) {
      const bytes = new TextEncoder().encode(JSON.stringify(output));
      outputRef = await this.deps.artifacts.put({ bytes, mediaType: "application/json", classification: prepared.classification, tenantId: principal.tenantId, runId });
      await this.deps.artifacts.commit?.(outputRef, { tenantId: principal.tenantId, runId });
      output = undefined;
    }
    const result: ToolResult = { callId, toolRef: def.ref, status, effect, meta: { attempts: attempts.length, durationMs: Date.now() - started, bytes: observed.transport.bytes } };
    if (output !== undefined) result.output = output;
    if (outputRef) result.outputRef = outputRef;
    if (error) result.error = error;
    let view = this.modelView(result);
    for (const hook of this.deps.hooks) {
      if (hook.point !== "afterToolView" || !hook.afterToolView) continue;
      try {
        const res = await withTimeout(hook.timeoutMs, () => hook.afterToolView!({ toolRef: def.ref, view, principal }), { label: `hook ${hook.id}` });
        if (res?.view) view = { ...res.view, callId };
      } catch (e) {
        if (hook.onFailure === "fail") throw new SFieldError("HOOK_TIMEOUT", `hook ${hook.id} failed: ${(e as Error).message}`, { runId, callId });
      }
    }

    // 10. Commit result, accounting, and durable events together.
    const state: CallState = status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "outcome_unknown";
    const reservationState = status === "outcome_unknown" ? "uncertain" : "settled";
    const finishedEvent = this.event(runId, req.conversationId, "tool_finished", { callId, toolRef: def.ref, status, effect, attempts: attempts.length, durationMs: result.meta.durationMs, bytes: result.meta.bytes, error: error ? { code: error.code } : null, outputRef: outputRef ? outputRef.id : null });
    const events = [finishedEvent];
    if (status === "outcome_unknown") events.push(this.event(runId, req.conversationId, "reconciliation_required", { callId, toolRef: def.ref, effect }));
    await p.commitResult({
      runId,
      epoch,
      callId,
      result,
      state,
      reservation: { id: reservationId, actualMicroUsd: def.policy.costMicroUsd, state: reservationState },
      events,
      audit: [
        ...attempts.map((a) => this.audit(principal, runId, callId, "tool_attempt", { attemptId: a.attemptId, durationMs: a.durationMs, outcome: a.outcome })),
        this.audit(principal, runId, callId, "tool_result", { toolRef: def.ref, status, effect, bytes: result.meta.bytes, outputRef: outputRef?.id ?? null, error: error ? { code: error.code } : null, invocationDigest: invocation.digest }),
      ],
      attempt: attempts[attempts.length - 1],
    });
    req.onEvents?.(events.map((e, i) => ({ ...e, seq: undefined })).length ? await p.readEvents(runId, 0, 0).then(() => events) : events);
    this.deps.telemetry?.metric?.("sfield.tool.duration_ms", result.meta.durationMs, { tool: def.id, status });
    return { result, view, state };
  }

  /** Recovery for a call whose durable evidence is an intent without a conclusive result (§16.4). */
  async recover(call: CallRecord, principal: Principal, signal: AbortSignal): Promise<{ result: ToolResult; resolved: boolean }> {
    const def = this.deps.registry.get(call.toolRef);
    if (call.result && call.state === "succeeded") return { result: call.result, resolved: true };
    if (!def || !call.invocation) {
      return { result: { callId: call.callId, toolRef: call.toolRef, status: "outcome_unknown", effect: "unknown", error: { code: "STATE_UNAVAILABLE", category: "availability", message: "call cannot be recovered" }, meta: { attempts: 0, durationMs: 0, bytes: 0 } }, resolved: false };
    }
    if (def.policy.effect === "read" && call.state !== "succeeded") {
      // Reads have no effect to reconcile; the caller may re-execute under normal authorization.
      return { result: { callId: call.callId, toolRef: call.toolRef, status: "failed", effect: "none", error: { code: "OUTCOME_UNKNOWN", category: "effect_uncertainty", message: "read interrupted before its result was recorded" }, meta: { attempts: 0, durationMs: 0, bytes: 0 } }, resolved: true };
    }
    const reconcileName = def.deduplication?.reconcileBinding;
    const adapter = this.deps.registry.getAdapter(def.adapter);
    let outcome: { effect: "confirmed" | "none" | "unknown"; output?: JsonValue } | undefined;
    if (reconcileName && this.deps.reconciliation[reconcileName]) {
      outcome = await this.deps.reconciliation[reconcileName]!({ principal, intent: { ...(call.intent as JsonObject), operation: call.invocation.operation.operation }, callId: call.callId });
    } else if (adapter?.reconcile) {
      let connection: ConnectionHandle | undefined;
      if (def.connection) connection = await this.deps.connections[def.connection]?.resolve(principal, def);
      outcome = await adapter.reconcile(call.invocation.operation, { principal, signal, callId: call.callId, runId: call.runId, idempotencyKey: call.intent?.idempotencyKey, connection, intent: call.intent as unknown as JsonObject });
    }
    if (!outcome || outcome.effect === "unknown") {
      return { result: { callId: call.callId, toolRef: call.toolRef, status: "outcome_unknown", effect: "unknown", error: { code: "RECONCILIATION_REQUIRED", category: "effect_uncertainty", message: "remote outcome could not be established; an authorized operator must record a resolution" }, meta: { attempts: call.attempts.length, durationMs: 0, bytes: 0 } }, resolved: false };
    }
    if (outcome.effect === "none") {
      return { result: { callId: call.callId, toolRef: call.toolRef, status: "failed", effect: "none", error: { code: "OUTCOME_UNKNOWN", category: "effect_uncertainty", message: "reconciliation confirmed no effect; retry only under the configured attempt policy" }, meta: { attempts: call.attempts.length, durationMs: 0, bytes: 0 } }, resolved: true };
    }
    const result: ToolResult = { callId: call.callId, toolRef: call.toolRef, status: "succeeded", effect: "confirmed", meta: { attempts: call.attempts.length, durationMs: 0, bytes: 0 } };
    if (outcome.output !== undefined) {
      const candidate = def.outputSelect ? applySelect(outcome.output, def.outputSelect) : outcome.output;
      const v = sharedValidator().validate(def.outputs, candidate);
      if (v.ok) result.output = candidate;
      else {
        result.status = "failed";
        result.error = { code: "INVALID_OUTPUT", category: "validation", message: "reconciled output does not match the declared schema" };
      }
    }
    return { result, resolved: true };
  }

  modelView(result: ToolResult): ToolResultView {
    if (result.status === "succeeded" && result.output !== undefined) {
      const s = shortenForModel(result.output, this.deps.modelViewLimitBytes);
      return { callId: result.callId, content: s.content, partial: s.partial, isError: false };
    }
    if (result.status === "succeeded" && result.outputRef) {
      return { callId: result.callId, content: { partial: true, artifact_id: result.outputRef.id, bytes: result.outputRef.bytes, media_type: result.outputRef.mediaType, note: "result stored as an artifact" }, partial: true, isError: false };
    }
    const err = result.error ?? { code: "TOOL_ERROR", message: "tool failed" };
    const content: JsonObject = { error: { code: err.code, message: err.message } };
    if (result.effect === "confirmed") content["effect"] = "confirmed";
    if (result.effect === "unknown") content["effect"] = "unknown";
    if (result.status === "failed" && result.error?.code === "INVALID_OUTPUT" && result.output !== undefined) content["output"] = shortenForModel(result.output, this.deps.modelViewLimitBytes).content;
    return { callId: result.callId, content, partial: false, isError: true };
  }

  private async rejected(req: DispatchRequest, code: string, reason: string, started: number): Promise<DispatchOutcome> {
    const { prepared, runId, epoch, principal } = req;
    const result: ToolResult = { callId: prepared.invocation.callId, toolRef: prepared.def.ref, status: "failed", effect: "not_started", error: { code, category: code.startsWith("BUDGET") ? "accounting" : "authorization", message: this.deps.scrubber.scrubText(reason) }, meta: { attempts: 0, durationMs: Date.now() - started, bytes: 0 } };
    const events = [this.event(runId, req.conversationId, "tool_finished", { callId: result.callId, toolRef: prepared.def.ref, status: "failed", effect: "not_started", error: { code } })];
    await this.deps.persistence.commitResult({ runId, epoch, callId: result.callId, result, state: "rejected", events, audit: [this.audit(principal, runId, result.callId, "tool_rejected", { code, reason })] });
    req.onEvents?.(events);
    return { result, view: this.modelView(result), state: "rejected" };
  }

  private event(runId: string, conversationId: string | undefined, type: string, payload: JsonObject): RunEvent {
    const ev: RunEvent = { v: 1, id: newId("evt"), runId, timestamp: nowIso(), type, payload };
    if (conversationId) ev.conversationId = conversationId;
    return ev;
  }

  private audit(principal: Principal, runId: string, callId: string, type: string, data: JsonObject): AuditRecord {
    const rec: AuditRecord = { id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, runId, callId, type, principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, configDigest: this.deps.configDigest, data };
    if (this.deps.preset) rec.preset = this.deps.preset;
    return rec;
  }
}

/** Approval views show amounts where the arguments carry a minor-unit amount and currency. */
export function amountOf(inputs: JsonObject): ApprovalView["amount"] | undefined {
  const value = inputs["amount_minor"] ?? inputs["amount"];
  const currency = inputs["currency"];
  if (typeof value === "number" && typeof currency === "string") return { value, currency, unit: "minor" };
  return undefined;
}
