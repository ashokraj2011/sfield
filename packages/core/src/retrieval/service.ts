/** Authorized retrieval with per-source limits, freshness, and explicit omissions (§11). */
import type { JsonValue, Principal } from "../types/common.js";
import type { EffectiveContextSource } from "../config/types.js";
import type { RetrievalBinding, RetrievedItem } from "../types/retrieval.js";
import { SFieldError } from "../errors.js";
import { TimeoutError, withTimeout } from "../util/async.js";

export interface RetrievalOutcome {
  sourceId: string;
  items: RetrievedItem[];
  partial: boolean;
  /** Non-disclosing omission reasons (§11.1). */
  omissions: Array<{ reason: string; count?: number }>;
  failed?: { code: string; message: string };
  durationMs: number;
  empty: boolean;
}

export class RetrievalService {
  constructor(private readonly bindings: Map<string, RetrievalBinding>) {}

  has(sourceId: string): boolean {
    return this.bindings.has(sourceId);
  }

  binding(sourceId: string): RetrievalBinding | undefined {
    return this.bindings.get(sourceId);
  }

  async query(cfg: EffectiveContextSource, args: { principal: Principal; text: string; signal?: AbortSignal; maxBytes: number; now?: number }): Promise<RetrievalOutcome> {
    const started = Date.now();
    const binding = this.bindings.get(cfg.source);
    if (!binding) {
      return { sourceId: cfg.source, items: [], partial: false, omissions: [{ reason: "source_unavailable" }], failed: { code: "UNKNOWN_SOURCE", message: `source ${cfg.source} is not bound` }, durationMs: 0, empty: false };
    }
    const filters: Record<string, JsonValue> = { ...(cfg.filters ?? {}) };
    try {
      const result = await withTimeout(
        cfg.timeout_ms,
        (signal) => binding.search({ principal: args.principal, text: args.text, filters, maxItems: cfg.max_items, maxBytes: args.maxBytes, signal }),
        { label: `source ${cfg.source}`, parent: args.signal },
      );
      const omissions: RetrievalOutcome["omissions"] = [];
      const now = args.now ?? Date.now();
      const accepted: RetrievedItem[] = [];
      let unauthorized = 0;
      let stale = 0;
      for (const item of result.items.slice(0, cfg.max_items)) {
        if (cfg.max_age_seconds !== undefined && now - Date.parse(item.observedAt) > cfg.max_age_seconds * 1000) {
          stale++;
          continue;
        }
        if (item.validUntil && Date.parse(item.validUntil) <= now) {
          stale++;
          continue;
        }
        const ok = await binding.authorizeItem(item, args.principal).catch(() => false);
        if (!ok) {
          unauthorized++;
          continue;
        }
        accepted.push(item);
      }
      if (stale > 0) omissions.push({ reason: "stale", count: stale });
      // Never disclose how many hidden records exist.
      if (unauthorized > 0) omissions.push({ reason: "not_authorized" });
      return { sourceId: cfg.source, items: accepted, partial: result.partial, omissions, durationMs: Date.now() - started, empty: accepted.length === 0 && !result.partial };
    } catch (e) {
      const code = e instanceof TimeoutError ? "SOURCE_TIMEOUT" : SFieldError.is(e) ? e.code : "SOURCE_UNAVAILABLE";
      const message = e instanceof Error ? e.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "source failed";
      return { sourceId: cfg.source, items: [], partial: false, omissions: [{ reason: code === "SOURCE_TIMEOUT" ? "source_timeout" : "source_unavailable" }], failed: { code, message }, durationMs: Date.now() - started, empty: false };
    }
  }
}
