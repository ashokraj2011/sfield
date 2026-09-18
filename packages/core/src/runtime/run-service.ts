/** Request acceptance, sessions, and resumption (§7.2, §14.3, §16.5). */
import type { ArtifactRef, Principal, SendRequest } from "../types/common.js";
import type { EffectiveConfig } from "../config/types.js";
import type { ArtifactStore, ConversationRecord, ExecutionPersistence, MessageRecord, RunRecord } from "../types/persistence.js";
import type { RunHandle, Session } from "../types/runtime.js";
import { isTerminal, SUSPENDED_RUN_STATES } from "../types/runtime.js";
import { SFieldError } from "../errors.js";
import { digestJson, newId, nowIso } from "../util/digest.js";
import type { EventBus } from "./events.js";
import { RunHandleImpl } from "./run-handle.js";
import type { Scheduler } from "./scheduler.js";
import type { ToolRegistry } from "../registry/registry.js";

export interface RunServiceDeps {
  /** The configuration new runs pin to; reload swaps it atomically (§20.2). */
  config: () => EffectiveConfig;
  /** Whether a pinned version's executable dependencies are still loaded. */
  hasVersion: (digest: string) => boolean;
  persistence: ExecutionPersistence;
  scheduler: Scheduler;
  bus: EventBus;
  registry: ToolRegistry;
  artifacts: ArtifactStore;
  requestMaxBytes: number;
  idempotencyRetentionMs: number;
  preset?: string;
  devPrincipal?: Principal;
}

export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  resolvePrincipal(principal: Principal | undefined): Principal {
    if (principal) {
      if (!principal.tenantId || !principal.subjectId) throw new SFieldError("ACCESS_DENIED", "principal needs tenantId and subjectId");
      return { tenantId: principal.tenantId, subjectId: principal.subjectId, roles: [...(principal.roles ?? [])], attributes: { ...(principal.attributes ?? {}) } };
    }
    if (this.deps.devPrincipal) return this.deps.devPrincipal;
    throw new SFieldError("ACCESS_DENIED", "principal is required outside a development preset", { suggestion: "Map the authenticated request to a Principal at the host boundary (§4.7)" });
  }

  async openSession(input: { agent: string; principal?: Principal; conversationId?: string }): Promise<Session> {
    const principal = this.resolvePrincipal(input.principal);
    const agent = this.deps.config().agents[input.agent];
    if (!agent) throw new SFieldError("UNKNOWN_AGENT", `agent ${input.agent} is not configured`, { suggestion: `Configured agents: ${Object.keys(this.deps.config().agents).join(", ") || "none"}` });
    let conversation: ConversationRecord | null = null;
    if (input.conversationId) {
      conversation = await this.deps.persistence.getConversation(input.conversationId);
      if (!conversation || conversation.tenantId !== principal.tenantId || conversation.subjectId !== principal.subjectId || conversation.deletedAt) {
        throw new SFieldError("ACCESS_DENIED", `conversation ${input.conversationId} is not accessible to this principal`);
      }
    } else {
      conversation = await this.deps.persistence.createConversation({ id: newId("conv"), tenantId: principal.tenantId, subjectId: principal.subjectId, agentId: agent.id, createdAt: nowIso(), updatedAt: nowIso(), messageCount: 0 });
    }
    const conv = conversation;
    const service = this;
    return {
      id: newId("sess"),
      conversationId: conv.id,
      agentId: agent.id,
      send: (request: SendRequest) => service.accept({ agentId: agent.id, principal, request, conversationId: conv.id, kind: "session" }),
      close: async () => undefined,
    };
  }

  async accept(input: { agentId: string; principal: Principal; request: SendRequest; conversationId?: string; kind: "session" | "standalone" }): Promise<RunHandle> {
    const { principal, request } = input;
    const agent = this.deps.config().agents[input.agentId];
    if (!agent) throw new SFieldError("UNKNOWN_AGENT", `agent ${input.agentId} is not configured`);
    if (!request?.message || typeof request.message.text !== "string") throw new SFieldError("INVALID_INPUT", "request.message.text is required");
    if (this.deps.scheduler.isClosing) throw new SFieldError("STATE_UNAVAILABLE", "the instance is closing; admission is stopped", { retryable: false });
    const bytes = Buffer.byteLength(JSON.stringify({ message: request.message, inputs: request.inputs ?? null }), "utf8");
    if (bytes > this.deps.requestMaxBytes) throw new SFieldError("REQUEST_TOO_LARGE", `request of ${bytes} bytes exceeds ${this.deps.requestMaxBytes}`);
    this.deps.registry.freeze();
    const idempotencyKey = request.idempotencyKey ?? newId("req");
    const idempotencyScope = JSON.stringify([principal.tenantId, principal.subjectId, agent.id, input.conversationId ?? "standalone"]);
    const requestDigest = digestJson({ message: request.message, inputs: request.inputs ?? null });
    if (input.conversationId) {
      const conv = await this.deps.persistence.getConversation(input.conversationId);
      if (conv?.activeRunId) {
        const active = await this.deps.persistence.getRun(conv.activeRunId);
        if (active && !isTerminal(active.state)) throw new SFieldError("CONVERSATION_BUSY", `conversation ${input.conversationId} has an active run ${active.runId}`, { suggestion: "Wait for the run to finish or suspend; the first release does not interleave messages" });
      }
    }
    const runId = newId("run");
    const now = nowIso();
    const retentionMs = agent.memory.retention_days.conversation * 86400000;
    const record: Omit<RunRecord, "epoch" | "lastEventSeq" | "updatedAt" | "createdAt"> = {
      runId,
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      principal,
      agentId: agent.id,
      conversationId: input.conversationId,
      kind: input.kind,
      scopeId: input.conversationId ?? runId,
      state: "queued",
      request: { message: request.message, inputs: request.inputs, idempotencyKey },
      requestDigest,
      idempotencyKey,
      idempotencyScope,
      configDigest: this.deps.config().digest,
      expiresAt: new Date(Date.now() + agent.budget.max_elapsed_seconds * 1000).toISOString(),
      effects: [],
      usage: { turns: 0, modelCalls: 0, providerAttempts: 0, toolCalls: 0, toolAttempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensReported: true, costMicroUsd: 0, costLabel: "unpriced", activeMs: 0, elapsedMs: 0 },
      pending: { approvals: [], inputs: [] },
      preset: this.deps.preset,
    };
    const message: Omit<MessageRecord, "index" | "id"> | undefined = input.conversationId && agent.memory.conversation
      ? { conversationId: input.conversationId, tenantId: principal.tenantId, runId, role: "user", content: { text: request.message.text, attachments: (request.message.attachments ?? []) as unknown as import("../types/common.js").JsonValue }, createdAt: now, expiresAt: new Date(Date.now() + retentionMs).toISOString() }
      : undefined;
    const accepted = await this.deps.persistence.acceptRequest({ run: record, message, retentionMs: Math.max(this.deps.idempotencyRetentionMs, agent.budget.max_elapsed_seconds * 1000) });
    const handle = new RunHandleImpl({ persistence: this.deps.persistence, bus: this.deps.bus, scheduler: this.deps.scheduler }, accepted.run.runId, accepted.run.idempotencyKey, principal);
    if (!accepted.created) return handle; // identical reuse returns the original run (§16.5)
    if (input.conversationId) {
      const ok = await this.deps.persistence.setActiveRun(input.conversationId, runId);
      if (!ok) {
        const claim = await this.deps.persistence.claim(accepted.run.scopeId, "admission", 5000);
        if (claim) {
          await this.deps.persistence.updateRun(runId, claim.epoch, { state: "failed", error: { code: "CONVERSATION_BUSY", category: "coordination", message: "conversation has an active run", retryable: true } });
          await this.deps.persistence.release(claim);
        }
        throw new SFieldError("CONVERSATION_BUSY", `conversation ${input.conversationId} has an active run`);
      }
    }
    const events = await this.deps.persistence.appendEvents(runId, null, [{ v: 1, id: newId("evt"), runId, conversationId: input.conversationId, timestamp: now, type: "run_accepted", payload: { agentId: agent.id, idempotencyKey, kind: input.kind } }]);
    this.deps.bus.publish(events);
    this.deps.scheduler.schedule(runId, accepted.run.scopeId).catch(() => undefined);
    return handle;
  }

  async get(input: { runId: string; principal?: Principal }): Promise<RunHandle> {
    const principal = this.resolvePrincipal(input.principal);
    const run = await this.deps.persistence.getRun(input.runId);
    if (!run || run.tenantId !== principal.tenantId || run.subjectId !== principal.subjectId) throw new SFieldError("NOT_FOUND", `run ${input.runId} not found`);
    return new RunHandleImpl({ persistence: this.deps.persistence, bus: this.deps.bus, scheduler: this.deps.scheduler }, run.runId, run.idempotencyKey, principal);
  }

  /** Reevaluates authorization with the caller's current principal and claims eligible suspended work. */
  async resume(input: { runId: string; principal?: Principal }): Promise<RunHandle> {
    const principal = this.resolvePrincipal(input.principal);
    const run = await this.deps.persistence.getRun(input.runId);
    if (!run || run.tenantId !== principal.tenantId || run.subjectId !== principal.subjectId) throw new SFieldError("NOT_FOUND", `run ${input.runId} not found`);
    if (isTerminal(run.state)) throw new SFieldError("RUN_NOT_RESUMABLE", `run ${run.runId} is ${run.state}`);
    if (!this.deps.hasVersion(run.configDigest)) {
      throw new SFieldError("RUN_NOT_RESUMABLE", `run ${run.runId} is pinned to configuration ${run.configDigest}, whose executable dependencies are not loaded (running: ${this.deps.config().digest})`);
    }
    if (SUSPENDED_RUN_STATES.has(run.state) || run.state === "queued") {
      const claim = await this.deps.persistence.claim(run.scopeId, "resume", 5000);
      if (claim) {
        await this.deps.persistence.updateRun(run.runId, claim.epoch, { principal, wakeup: { at: nowIso(), reason: "resume" } });
        await this.deps.persistence.release(claim);
      }
      this.deps.scheduler.schedule(run.runId, run.scopeId).catch(() => undefined);
    }
    return new RunHandleImpl({ persistence: this.deps.persistence, bus: this.deps.bus, scheduler: this.deps.scheduler }, run.runId, run.idempotencyKey, principal);
  }

  async history(input: { id: string; principal?: Principal; limit?: number }): Promise<MessageRecord[]> {
    const principal = this.resolvePrincipal(input.principal);
    const conv = await this.deps.persistence.getConversation(input.id);
    if (!conv || conv.tenantId !== principal.tenantId || conv.subjectId !== principal.subjectId || conv.deletedAt) throw new SFieldError("NOT_FOUND", `conversation ${input.id} not found`);
    return this.deps.persistence.listMessages(input.id, { limit: input.limit ?? 100 });
  }

  async exportConversation(input: { id: string; principal?: Principal }): Promise<ArtifactRef> {
    const principal = this.resolvePrincipal(input.principal);
    const messages = await this.history({ id: input.id, principal });
    const bytes = new TextEncoder().encode(JSON.stringify({ conversationId: input.id, exportedAt: nowIso(), messages }, null, 2));
    const ref = await this.deps.artifacts.put({ bytes, mediaType: "application/json", classification: "confidential", tenantId: principal.tenantId });
    await this.deps.artifacts.commit?.(ref, { tenantId: principal.tenantId });
    return ref;
  }

  async deleteConversation(input: { id: string; principal?: Principal }): Promise<{ messages: number }> {
    const principal = this.resolvePrincipal(input.principal);
    const conv = await this.deps.persistence.getConversation(input.id);
    if (!conv || conv.tenantId !== principal.tenantId || conv.subjectId !== principal.subjectId) throw new SFieldError("NOT_FOUND", `conversation ${input.id} not found`);
    if (conv.activeRunId) {
      const active = await this.deps.persistence.getRun(conv.activeRunId);
      if (active && !isTerminal(active.state)) throw new SFieldError("CONVERSATION_BUSY", "cancel the active run before deleting the conversation");
    }
    const result = await this.deps.persistence.deleteConversation(input.id);
    await this.deps.persistence.appendAudit([{ id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, type: "conversation_deleted", principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, data: { conversationId: input.id, messages: result.messages, auditRetained: true }, preset: this.deps.preset }]);
    return result;
  }
}
