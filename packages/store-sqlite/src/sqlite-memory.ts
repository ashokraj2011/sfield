/**
 * SQLite MemoryRepository (§17.5): versioned get/list, idempotent create, compare-and-set update, deletion generations,
 * and mutation-plus-outbox in one transaction. Semantics mirror the in-memory reference repository.
 */
import type { MemoryFilter, MemoryItem, MemoryKind, MemoryOutboxEvent, MemoryRepository, MemoryScope, Page, PageRequest } from "@sfield/core";
import { SFieldError, newId, nowIso, scopeKey } from "@sfield/core";
import type { SqliteDatabase } from "./db.js";

type BodyRow = { body: string };

const UPSERT_ITEM = `INSERT INTO memory_items (tenant_id, id, scope_key, kind, status, structured_key, expires_at, valid_until, updated_at, body)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, id) DO UPDATE SET scope_key = excluded.scope_key, kind = excluded.kind, status = excluded.status,
    structured_key = excluded.structured_key, expires_at = excluded.expires_at, valid_until = excluded.valid_until,
    updated_at = excluded.updated_at, body = excluded.body`;

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  async get(tenantId: string, id: string): Promise<MemoryItem | null> {
    return this.load(tenantId, id);
  }

  async list(tenantId: string, filter: MemoryFilter, page: PageRequest = {}): Promise<Page<MemoryItem>> {
    const now = nowIso();
    const rows = filter.scope
      ? this.db.all<BodyRow>("SELECT body FROM memory_items WHERE tenant_id = ? AND scope_key = ?", tenantId, scopeKey(filter.scope))
      : this.db.all<BodyRow>("SELECT body FROM memory_items WHERE tenant_id = ?", tenantId);
    const all = rows.map((r) => JSON.parse(r.body) as MemoryItem).filter((it) => matches(it, filter, now));
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    const offset = page.cursor ? Number(page.cursor) : 0;
    const limit = Math.min(page.limit ?? 100, 500);
    const items = all.slice(offset, offset + limit);
    const out: Page<MemoryItem> = { items };
    if (offset + limit < all.length) out.nextCursor = String(offset + limit);
    return out;
  }

  async create(tenantId: string, item: MemoryItem, idempotencyKey: string): Promise<{ item: MemoryItem; created: boolean }> {
    return this.db.tx(() => {
      const prior = this.db.one<{ item_id: string }>("SELECT item_id FROM memory_idempotency WHERE tenant_id = ? AND key = ?", tenantId, idempotencyKey);
      if (prior) {
        const existing = this.load(tenantId, prior.item_id);
        if (existing) return { item: existing, created: false };
      }
      const sk = scopeKey(item.scope);
      const generation = this.generationSync(sk);
      this.put(tenantId, item);
      this.db.run(
        "INSERT INTO memory_idempotency (tenant_id, key, item_id) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET item_id = excluded.item_id",
        tenantId,
        idempotencyKey,
        item.id,
      );
      this.enqueue({ id: newId("mob"), itemId: item.id, version: item.version, scopeKey: sk, op: "upsert", generation, at: nowIso() });
      return { item: clone(item), created: true };
    });
  }

  async update(tenantId: string, id: string, ifVersion: string, next: MemoryItem): Promise<MemoryItem> {
    return this.db.tx(() => {
      const existing = this.load(tenantId, id);
      if (!existing) throw new SFieldError("NOT_FOUND", `memory item ${id} not found`);
      if (existing.version !== ifVersion) {
        throw new SFieldError("VERSION_CONFLICT", `memory item ${id} is at version ${existing.version}, not ${ifVersion}`, { suggestion: "Re-read the item and retry with its current version" });
      }
      this.put(tenantId, next);
      const sk = scopeKey(next.scope);
      this.enqueue({ id: newId("mob"), itemId: id, version: next.version, scopeKey: sk, op: "upsert", generation: this.generationSync(sk), at: nowIso() });
      return clone(next);
    });
  }

  async delete(tenantId: string, ids: string[], idempotencyKey: string): Promise<{ generation: number; count: number }> {
    return this.db.tx(() => {
      const prior = this.db.one<{ generation: number; count: number }>("SELECT generation, count FROM memory_deletes WHERE tenant_id = ? AND key = ?", tenantId, idempotencyKey);
      if (prior) return { generation: Number(prior.generation), count: Number(prior.count) };
      let count = 0;
      let generation = 0;
      for (const id of ids) {
        const item = this.load(tenantId, id);
        if (!item) continue;
        const sk = scopeKey(item.scope);
        const next = this.generationSync(sk) + 1;
        this.db.run("INSERT INTO memory_generations (scope_key, generation) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET generation = excluded.generation", sk, next);
        generation = Math.max(generation, next);
        this.db.run("DELETE FROM memory_items WHERE tenant_id = ? AND id = ?", tenantId, id);
        count++;
        this.enqueue({ id: newId("mob"), itemId: id, version: item.version, scopeKey: sk, op: "delete", generation: next, at: nowIso() });
      }
      this.db.run("INSERT INTO memory_deletes (tenant_id, key, generation, count) VALUES (?, ?, ?, ?)", tenantId, idempotencyKey, generation, count);
      return { generation, count };
    });
  }

  async generation(_tenantId: string, sk: string): Promise<number> {
    return this.generationSync(sk);
  }

  async countActive(tenantId: string, scope: MemoryScope, kind: MemoryKind): Promise<number> {
    const row = this.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memory_items WHERE tenant_id = ? AND scope_key = ? AND kind = ? AND status = 'active' AND expires_at > ?",
      tenantId,
      scopeKey(scope),
      kind,
      nowIso(),
    );
    return row ? Number(row.n) : 0;
  }

  async drainOutbox(max: number): Promise<MemoryOutboxEvent[]> {
    return this.db.all<BodyRow>("SELECT body FROM memory_outbox ORDER BY ord LIMIT ?", max).map((r) => JSON.parse(r.body) as MemoryOutboxEvent);
  }

  async ackOutbox(ids: string[]): Promise<void> {
    this.db.run("DELETE FROM memory_outbox WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
  }

  private load(tenantId: string, id: string): MemoryItem | null {
    const row = this.db.one<BodyRow>("SELECT body FROM memory_items WHERE tenant_id = ? AND id = ?", tenantId, id);
    return row ? (JSON.parse(row.body) as MemoryItem) : null;
  }

  private put(tenantId: string, item: MemoryItem): void {
    this.db.run(UPSERT_ITEM, tenantId, item.id, scopeKey(item.scope), item.kind, item.status, item.structured?.key ?? null, item.expiresAt, item.validUntil ?? null, item.updatedAt, JSON.stringify(item));
  }

  private generationSync(sk: string): number {
    const row = this.db.one<{ generation: number }>("SELECT generation FROM memory_generations WHERE scope_key = ?", sk);
    return row ? Number(row.generation) : 0;
  }

  private enqueue(event: MemoryOutboxEvent): void {
    this.db.run("INSERT INTO memory_outbox (id, body) VALUES (?, ?)", event.id, JSON.stringify(event));
  }
}

/** Filter semantics of the reference repository: active-only unless a status is given, expiry and validity windows, key and substring text. */
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
