/** In-memory MemoryRepository (§17.5): versioned get/list, idempotent create, CAS update, deletion generations, outbox. */
import type { Page, PageRequest } from "../types/common.js";
import type { MemoryFilter, MemoryItem, MemoryKind, MemoryOutboxEvent, MemoryRepository, MemoryScope } from "../types/memory.js";
import { scopeKey } from "../types/memory.js";
import { SFieldError } from "../errors.js";
import { newId, nowIso } from "../util/digest.js";

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly items = new Map<string, Map<string, MemoryItem>>();
  private readonly idempotency = new Map<string, string>();
  private readonly deletes = new Map<string, { generation: number; count: number }>();
  private readonly generations = new Map<string, number>();
  private outbox: MemoryOutboxEvent[] = [];

  private tenant(tenantId: string): Map<string, MemoryItem> {
    let m = this.items.get(tenantId);
    if (!m) {
      m = new Map();
      this.items.set(tenantId, m);
    }
    return m;
  }

  async get(tenantId: string, id: string): Promise<MemoryItem | null> {
    return this.tenant(tenantId).get(id) ?? null;
  }

  async list(tenantId: string, filter: MemoryFilter, page: PageRequest = {}): Promise<Page<MemoryItem>> {
    const now = nowIso();
    const all = [...this.tenant(tenantId).values()].filter((it) => matches(it, filter, now));
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    const offset = page.cursor ? Number(page.cursor) : 0;
    const limit = Math.min(page.limit ?? 100, 500);
    const items = all.slice(offset, offset + limit);
    const out: Page<MemoryItem> = { items };
    if (offset + limit < all.length) out.nextCursor = String(offset + limit);
    return out;
  }

  async create(tenantId: string, item: MemoryItem, idempotencyKey: string): Promise<{ item: MemoryItem; created: boolean }> {
    const key = `${tenantId}::${idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.tenant(tenantId).get(existingId);
      if (existing) return { item: existing, created: false };
    }
    const gen = this.generations.get(scopeKey(item.scope)) ?? 0;
    this.tenant(tenantId).set(item.id, item);
    this.idempotency.set(key, item.id);
    this.outbox.push({ id: newId("mob"), itemId: item.id, version: item.version, scopeKey: scopeKey(item.scope), op: "upsert", generation: gen, at: nowIso() });
    return { item, created: true };
  }

  async update(tenantId: string, id: string, ifVersion: string, next: MemoryItem): Promise<MemoryItem> {
    const m = this.tenant(tenantId);
    const existing = m.get(id);
    if (!existing) throw new SFieldError("NOT_FOUND", `memory item ${id} not found`);
    if (existing.version !== ifVersion) throw new SFieldError("VERSION_CONFLICT", `memory item ${id} is at version ${existing.version}, not ${ifVersion}`, { suggestion: "Re-read the item and retry with its current version" });
    m.set(id, next);
    this.outbox.push({ id: newId("mob"), itemId: id, version: next.version, scopeKey: scopeKey(next.scope), op: "upsert", generation: this.generations.get(scopeKey(next.scope)) ?? 0, at: nowIso() });
    return next;
  }

  async delete(tenantId: string, ids: string[], idempotencyKey: string): Promise<{ generation: number; count: number }> {
    const key = `${tenantId}::${idempotencyKey}`;
    const prior = this.deletes.get(key);
    if (prior) return prior;
    const m = this.tenant(tenantId);
    let count = 0;
    let generation = 0;
    for (const id of ids) {
      const it = m.get(id);
      if (!it) continue;
      const sk = scopeKey(it.scope);
      const gen = (this.generations.get(sk) ?? 0) + 1;
      this.generations.set(sk, gen);
      generation = Math.max(generation, gen);
      m.delete(id);
      count++;
      this.outbox.push({ id: newId("mob"), itemId: id, version: it.version, scopeKey: sk, op: "delete", generation: gen, at: nowIso() });
    }
    const result = { generation, count };
    this.deletes.set(key, result);
    return result;
  }

  async generation(_tenantId: string, sk: string): Promise<number> {
    return this.generations.get(sk) ?? 0;
  }

  async countActive(tenantId: string, scope: MemoryScope, kind: MemoryKind): Promise<number> {
    const sk = scopeKey(scope);
    const now = nowIso();
    let n = 0;
    for (const it of this.tenant(tenantId).values()) {
      if (scopeKey(it.scope) === sk && it.kind === kind && it.status === "active" && it.expiresAt > now) n++;
    }
    return n;
  }

  async drainOutbox(max: number): Promise<MemoryOutboxEvent[]> {
    return this.outbox.slice(0, max);
  }

  async ackOutbox(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.outbox = this.outbox.filter((e) => !set.has(e.id));
  }
}

export function matches(it: MemoryItem, filter: MemoryFilter, now: string): boolean {
  if (filter.scope && scopeKey(it.scope) !== scopeKey(filter.scope)) return false;
  if (filter.kind) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    if (!kinds.includes(it.kind)) return false;
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(it.status)) return false;
  } else if (it.status !== "active") return false;
  if (!filter.includeExpired && it.expiresAt <= now) return false;
  if (!filter.includeExpired && it.validUntil && it.validUntil <= now) return false;
  if (filter.key !== undefined && it.structured?.key !== filter.key) return false;
  if (filter.text && !it.content.toLowerCase().includes(filter.text.toLowerCase())) return false;
  return true;
}
