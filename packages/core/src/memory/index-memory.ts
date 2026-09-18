/** In-memory MemoryIndex (§17.5): lexical candidate search that honours deletion generations. */
import type { MemoryIndex, MemoryItem, MemoryOutboxEvent } from "../types/memory.js";
import { scopeKey } from "../types/memory.js";

export class InMemoryMemoryIndex implements MemoryIndex {
  private readonly entries = new Map<string, { tenantId: string; scopeKey: string; version: string; text: string; generation: number }>();
  private readonly tombstones = new Map<string, number>();
  private lag = 0;

  async upsert(tenantId: string, item: MemoryItem, generation = 0): Promise<void> {
    const sk = scopeKey(item.scope);
    const floor = this.tombstones.get(`${tenantId}:${sk}`) ?? 0;
    // A stale job carrying an older generation than the scope's deletion marker must not resurrect content (§10.6).
    if (generation < floor) return;
    this.entries.set(`${tenantId}:${item.id}`, { tenantId, scopeKey: sk, version: item.version, text: `${item.structured?.key ?? ""} ${item.content}`.toLowerCase(), generation });
  }

  async delete(tenantId: string, id: string, generation: number): Promise<void> {
    const key = `${tenantId}:${id}`;
    const entry = this.entries.get(key);
    if (entry) {
      const tk = `${tenantId}:${entry.scopeKey}`;
      this.tombstones.set(tk, Math.max(this.tombstones.get(tk) ?? 0, generation));
    }
    this.entries.delete(key);
  }

  /** Applies repository outbox events in order; deletes raise the scope generation, older upserts are dropped. */
  async applyOutbox(tenantId: string, events: MemoryOutboxEvent[], lookup: (id: string) => Promise<MemoryItem | null>): Promise<void> {
    for (const e of events) {
      if (e.op === "delete") {
        const tk = `${tenantId}:${e.scopeKey}`;
        this.tombstones.set(tk, Math.max(this.tombstones.get(tk) ?? 0, e.generation));
        this.entries.delete(`${tenantId}:${e.itemId}`);
        continue;
      }
      const item = await lookup(e.itemId);
      if (!item) continue;
      await this.upsert(tenantId, item, e.generation);
    }
  }

  async search(tenantId: string, sk: string, text: string, maxItems: number): Promise<Array<{ id: string; version: string; score: number }>> {
    const terms = text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    const out: Array<{ id: string; version: string; score: number }> = [];
    for (const [key, e] of this.entries) {
      if (e.tenantId !== tenantId || e.scopeKey !== sk) continue;
      const score = terms.filter((t) => e.text.includes(t)).length;
      if (score > 0) out.push({ id: key.slice(tenantId.length + 1), version: e.version, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, maxItems);
  }

  lagMs(): number {
    return this.lag;
  }
}
