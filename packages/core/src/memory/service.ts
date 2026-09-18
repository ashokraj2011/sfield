/** Memory service (§10): principal-bound handles, explicit writes, caps, supersession, forgetting. */
import type { ArtifactRef, Page, PageRequest, Principal } from "../types/common.js";
import type { DeletionReceipt, MemoryFilter, MemoryHandle, MemoryIndex, MemoryItem, MemoryKind, MemoryPatch, MemoryRepository, MemoryScope, MemoryTarget, NewMemoryItem } from "../types/memory.js";
import { scopeKey } from "../types/memory.js";
import type { Authorizer, RegisteredHook } from "../types/options.js";
import type { ArtifactStore, AuditRecord } from "../types/persistence.js";
import { SFieldError } from "../errors.js";
import { digestJson, newId, nowIso } from "../util/digest.js";
import { withTimeout } from "../util/async.js";

export interface MemoryServiceOptions {
  repository: MemoryRepository;
  index?: MemoryIndex;
  artifacts: ArtifactStore;
  caps: { preferences: number; facts: number };
  retentionDays: { preferences: number; facts: number; conversation: number };
  hooks?: RegisteredHook[];
  authorizer?: Authorizer;
  audit: (records: AuditRecord[]) => Promise<void>;
  preset?: string;
}

const SECRET_PATTERNS = [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\b(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S{6,}/i, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  capabilities(): { physical: DeletionReceipt["physical"]; vectors: boolean } {
    return { physical: { canonical: "immediate", index: this.opts.index ? "scheduled" : "unsupported", derived: "scheduled" }, vectors: !!this.opts.index };
  }

  for(principal: Principal): MemoryHandle {
    return new PrincipalMemoryHandle(this, principal);
  }

  /** Active, unexpired items for context assembly, newest first. */
  async listForContext(principal: Principal, scope: MemoryScope, kind: MemoryKind, max: number): Promise<MemoryItem[]> {
    await this.authorizeScope(principal, scope, "read");
    const page = await this.opts.repository.list(principal.tenantId, { scope, kind, status: "active" }, { limit: max });
    return page.items;
  }

  async authorizeScope(principal: Principal, scope: MemoryScope, mode: "read" | "write"): Promise<void> {
    if (scope.tenantId !== principal.tenantId) throw new SFieldError("ACCESS_DENIED", "memory scope is outside the principal's tenant");
    if (scope.kind === "subject" && scope.subjectId !== principal.subjectId) throw new SFieldError("ACCESS_DENIED", "memory scope belongs to another subject");
    if (scope.kind === "entity") {
      if (!this.opts.authorizer) throw new SFieldError("ACCESS_DENIED", "entity memory requires a resource authorizer");
      const d = await this.opts.authorizer.authorize({
        principal,
        action: mode === "read" ? "memory.read" : "memory.write",
        resource: { type: scope.entityType, id: scope.entityId, bindingIdentity: { id: "memory", revision: "1", accountScope: principal.tenantId, classification: "confidential" } },
        argumentsDigest: digestJson(scope),
        runId: "memory",
        effect: mode === "read" ? "read" : "write",
      });
      if (d.decision !== "allow") throw new SFieldError("ACCESS_DENIED", `entity memory ${mode} denied: ${d.reason}`);
    }
  }

  async put(principal: Principal, input: NewMemoryItem, opts: { idempotencyKey: string; actorNote?: string }): Promise<MemoryItem> {
    await this.authorizeScope(principal, input.scope, "write");
    if (input.kind === "summary" && input.origin !== "derived") throw new SFieldError("INVALID_INPUT", "summaries are derived context");
    if (typeof input.content !== "string" || input.content.trim().length === 0 || input.content.length > 4000) throw new SFieldError("INVALID_INPUT", "memory content must be 1-4000 characters");
    if (looksLikeSecret(input.content) || (input.structured && looksLikeSecret(JSON.stringify(input.structured.value)))) {
      throw new SFieldError("INVALID_INPUT", "secrets and authentication material cannot be remembered", { suggestion: "Store credentials in the host secret resolver" });
    }
    if (!input.provenance || input.provenance.length === 0) throw new SFieldError("INVALID_INPUT", "memory writes require provenance");
    let item = input;
    for (const hook of this.opts.hooks ?? []) {
      if (hook.point !== "beforeMemoryWrite" || !hook.beforeMemoryWrite) continue;
      try {
        const res = await withTimeout(hook.timeoutMs, () => hook.beforeMemoryWrite!({ item, principal }), { label: `hook ${hook.id}` });
        if (res?.reject) throw new SFieldError("ACCESS_DENIED", `memory write rejected by hook ${hook.id}: ${res.reject}`);
        if (res?.item) item = res.item;
      } catch (e) {
        if (SFieldError.is(e, "ACCESS_DENIED")) throw e;
        if (hook.onFailure === "fail") throw new SFieldError("HOOK_TIMEOUT", `hook ${hook.id} failed: ${(e as Error).message}`);
      }
    }
    const cap = item.kind === "preference" ? this.opts.caps.preferences : item.kind === "fact" ? this.opts.caps.facts : Number.POSITIVE_INFINITY;
    const count = await this.opts.repository.countActive(principal.tenantId, item.scope, item.kind);
    const supersedeId = item.structured?.key ? await this.findActiveByKey(principal.tenantId, item.scope, item.kind, item.structured.key) : undefined;
    if (count >= cap && !supersedeId) {
      throw new SFieldError("MEMORY_CAPACITY", `cap of ${cap} active ${item.kind} items reached`, { suggestion: "Forget or update existing items" });
    }
    const now = nowIso();
    const retentionDays = item.kind === "preference" ? this.opts.retentionDays.preferences : item.kind === "fact" ? this.opts.retentionDays.facts : this.opts.retentionDays.conversation;
    let expiresAt = item.expiresAt ?? new Date(Date.parse(now) + retentionDays * 86400000).toISOString();
    if (item.validUntil && item.validUntil < expiresAt) expiresAt = item.validUntil;
    const record: MemoryItem = {
      id: newId("mem"),
      version: "1",
      scope: item.scope,
      kind: item.kind,
      content: item.content,
      origin: item.origin,
      provenance: item.provenance,
      classification: item.classification ?? "confidential",
      expiresAt,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    if (item.structured) record.structured = item.structured;
    if (item.validFrom) record.validFrom = item.validFrom;
    if (item.validUntil) record.validUntil = item.validUntil;
    if (item.confidence !== undefined) record.confidence = item.confidence;
    if (supersedeId) record.supersedes = supersedeId;
    const { item: stored, created } = await this.opts.repository.create(principal.tenantId, record, opts.idempotencyKey);
    if (created) {
      if (supersedeId) {
        const old = await this.opts.repository.get(principal.tenantId, supersedeId);
        if (old && old.status === "active") await this.opts.repository.update(principal.tenantId, old.id, old.version, { ...old, status: "superseded", version: bump(old.version), updatedAt: now });
      }
      if (this.opts.index) await this.opts.index.upsert(principal.tenantId, stored);
      await this.audit("memory_write", principal, { memoryId: stored.id, kind: stored.kind, scope: scopeKey(stored.scope), origin: stored.origin, supersedes: supersedeId ?? null, idempotencyKey: opts.idempotencyKey });
    }
    return stored;
  }

  private async findActiveByKey(tenantId: string, scope: MemoryScope, kind: MemoryKind, key: string): Promise<string | undefined> {
    const page = await this.opts.repository.list(tenantId, { scope, kind, key, status: "active" }, { limit: 1 });
    return page.items[0]?.id;
  }

  async update(principal: Principal, id: string, patch: MemoryPatch, opts: { ifVersion: string }): Promise<MemoryItem> {
    const existing = await this.opts.repository.get(principal.tenantId, id);
    if (!existing) throw new SFieldError("NOT_FOUND", `memory item ${id} not found`);
    await this.authorizeScope(principal, existing.scope, "write");
    if (patch.content !== undefined && looksLikeSecret(patch.content)) throw new SFieldError("INVALID_INPUT", "secrets cannot be remembered");
    const next: MemoryItem = { ...existing, version: bump(existing.version), updatedAt: nowIso() };
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.structured !== undefined) next.structured = patch.structured;
    if (patch.validUntil !== undefined) next.validUntil = patch.validUntil;
    if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt;
    if (patch.status !== undefined) next.status = patch.status;
    const stored = await this.opts.repository.update(principal.tenantId, id, opts.ifVersion, next);
    if (this.opts.index) await this.opts.index.upsert(principal.tenantId, stored);
    await this.audit("memory_update", principal, { memoryId: id, version: stored.version, fields: Object.keys(patch) });
    return stored;
  }

  async forget(principal: Principal, target: MemoryTarget, opts: { idempotencyKey: string }): Promise<DeletionReceipt> {
    let ids: string[] = [];
    if ("id" in target) {
      const it = await this.opts.repository.get(principal.tenantId, target.id);
      if (it) {
        await this.authorizeScope(principal, it.scope, "write");
        ids = [it.id];
      }
    } else if ("scope" in target) {
      await this.authorizeScope(principal, target.scope, "write");
      const page = await this.opts.repository.list(principal.tenantId, { scope: target.scope, kind: target.kind, status: ["active", "superseded", "disputed"], includeExpired: true }, { limit: 500 });
      ids = page.items.map((i) => i.id);
    } else {
      const scope: MemoryScope = { kind: "subject", tenantId: principal.tenantId, subjectId: principal.subjectId };
      const page = await this.opts.repository.list(principal.tenantId, { scope, status: ["active", "superseded", "disputed"], includeExpired: true }, { limit: 500 });
      ids = page.items.map((i) => i.id);
    }
    const { generation, count } = await this.opts.repository.delete(principal.tenantId, ids, opts.idempotencyKey);
    if (this.opts.index) for (const id of ids) await this.opts.index.delete(principal.tenantId, id, generation);
    const receipt: DeletionReceipt = {
      id: newId("del"),
      generation,
      count,
      requestedAt: nowIso(),
      physical: this.capabilities().physical,
      pending: this.opts.index ? ["index", "derived_summaries"] : ["derived_summaries"],
    };
    await this.audit("memory_forget", principal, { receiptId: receipt.id, generation, count, idempotencyKey: opts.idempotencyKey });
    return receipt;
  }

  async list(principal: Principal, filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>> {
    const scope: MemoryScope = filter.scope ?? { kind: "subject", tenantId: principal.tenantId, subjectId: principal.subjectId };
    await this.authorizeScope(principal, scope, "read");
    return this.opts.repository.list(principal.tenantId, { ...filter, scope }, page);
  }

  async get(principal: Principal, id: string): Promise<MemoryItem | null> {
    const it = await this.opts.repository.get(principal.tenantId, id);
    if (!it) return null;
    await this.authorizeScope(principal, it.scope, "read");
    return it;
  }

  async export(principal: Principal, filter: MemoryFilter): Promise<ArtifactRef> {
    const items: MemoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(principal, filter, { limit: 200, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && items.length < 5000);
    const bytes = new TextEncoder().encode(JSON.stringify({ exportedAt: nowIso(), count: items.length, items }, null, 2));
    const ref = await this.opts.artifacts.put({ bytes, mediaType: "application/json", classification: "confidential", tenantId: principal.tenantId });
    await this.opts.artifacts.commit?.(ref, { tenantId: principal.tenantId });
    await this.audit("memory_export", principal, { artifactId: ref.id, count: items.length });
    return ref;
  }

  private async audit(type: string, principal: Principal, data: AuditRecord["data"]): Promise<void> {
    const rec: AuditRecord = { id: newId("aud"), at: nowIso(), tenantId: principal.tenantId, type, principal: { tenantId: principal.tenantId, subjectId: principal.subjectId }, data };
    if (this.opts.preset) rec.preset = this.opts.preset;
    await this.opts.audit([rec]);
    await this.mirrorOutbox(principal.tenantId);
  }

  /** Repository outbox events are mirrored into the central audit stream, deduplicated by event id (§17.5). */
  private readonly mirrored = new Set<string>();
  async mirrorOutbox(tenantId: string): Promise<void> {
    const events = await this.opts.repository.drainOutbox(100);
    const fresh = events.filter((e) => !this.mirrored.has(e.id));
    if (fresh.length) {
      await this.opts.audit(fresh.map((e) => ({ id: `aud_outbox_${e.id}`, at: e.at, tenantId, type: "memory_outbox", data: { itemId: e.itemId, version: e.version, op: e.op, generation: e.generation, scopeKey: e.scopeKey }, preset: this.opts.preset })));
      for (const e of fresh) this.mirrored.add(e.id);
    }
    if (events.length) await this.opts.repository.ackOutbox(events.map((e) => e.id));
  }
}

function bump(version: string): string {
  const n = Number(version);
  return Number.isFinite(n) ? String(n + 1) : `${version}.1`;
}

class PrincipalMemoryHandle implements MemoryHandle {
  constructor(
    private readonly service: MemoryService,
    private readonly principal: Principal,
  ) {}
  list(filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>> {
    return this.service.list(this.principal, filter, page);
  }
  get(id: string): Promise<MemoryItem | null> {
    return this.service.get(this.principal, id);
  }
  put(input: NewMemoryItem, opts: { idempotencyKey: string }): Promise<MemoryItem> {
    return this.service.put(this.principal, input, opts);
  }
  update(id: string, patch: MemoryPatch, opts: { ifVersion: string }): Promise<MemoryItem> {
    return this.service.update(this.principal, id, patch, opts);
  }
  forget(target: MemoryTarget, opts: { idempotencyKey: string }): Promise<DeletionReceipt> {
    return this.service.forget(this.principal, target, opts);
  }
  export(filter: MemoryFilter): Promise<ArtifactRef> {
    return this.service.export(this.principal, filter);
  }
  capabilities(): { physical: DeletionReceipt["physical"]; vectors: boolean } {
    return this.service.capabilities();
  }
}
