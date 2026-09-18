/** Memory service contracts (§10). */
import type { ArtifactRef, DataClassification, JsonValue, Page, PageRequest } from "./common.js";

export type MemoryScope =
  | { kind: "subject"; tenantId: string; subjectId: string }
  | { kind: "conversation"; tenantId: string; conversationId: string }
  | { kind: "entity"; tenantId: string; entityType: string; entityId: string };

export type MemoryKind = "preference" | "fact" | "summary";
export type MemoryOrigin = "user_explicit" | "user_confirmed" | "trusted_source" | "derived";
export type MemoryStatus = "active" | "superseded" | "disputed";

export interface MemoryProvenance {
  sourceType: "message" | "tool" | "document" | "host";
  sourceId: string;
  sourceVersion?: string;
  messageSpan?: { start: number; end: number };
  observedAt: string;
}

export interface MemoryItem {
  id: string;
  version: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  structured?: { key: string; value: JsonValue };
  origin: MemoryOrigin;
  provenance: MemoryProvenance[];
  classification: DataClassification;
  validFrom?: string;
  validUntil?: string;
  expiresAt: string;
  status: MemoryStatus;
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  /** Uncalibrated estimate when supplied by an extraction plugin (§10.2). */
  confidence?: number;
}

export interface NewMemoryItem {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  structured?: { key: string; value: JsonValue };
  origin: MemoryOrigin;
  provenance: MemoryProvenance[];
  classification?: DataClassification;
  validFrom?: string;
  validUntil?: string;
  expiresAt?: string;
  supersedes?: string;
  confidence?: number;
}

export interface MemoryPatch {
  content?: string;
  structured?: { key: string; value: JsonValue };
  validUntil?: string;
  expiresAt?: string;
  status?: MemoryStatus;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  kind?: MemoryKind | MemoryKind[];
  status?: MemoryStatus | MemoryStatus[];
  key?: string;
  includeExpired?: boolean;
  text?: string;
}

export type MemoryTarget =
  | { id: string }
  | { scope: MemoryScope; kind?: MemoryKind }
  | { all: true };

export interface DeletionReceipt {
  id: string;
  generation: number;
  count: number;
  requestedAt: string;
  /** Physical deletion operations the bound backend supports (§10.6). */
  physical: { canonical: "immediate" | "scheduled" | "unsupported"; index: "immediate" | "scheduled" | "unsupported"; derived: "scheduled" | "unsupported" };
  pending: string[];
}

export interface MemoryHandle {
  list(filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>>;
  get(id: string): Promise<MemoryItem | null>;
  put(input: NewMemoryItem, opts: { idempotencyKey: string }): Promise<MemoryItem>;
  update(id: string, patch: MemoryPatch, opts: { ifVersion: string }): Promise<MemoryItem>;
  forget(target: MemoryTarget, opts: { idempotencyKey: string }): Promise<DeletionReceipt>;
  export(filter: MemoryFilter): Promise<ArtifactRef>;
  /** Discloses supported physical deletion operations. */
  capabilities(): { physical: DeletionReceipt["physical"]; vectors: boolean };
}

export interface MemoryOutboxEvent {
  id: string;
  itemId: string;
  version: string;
  scopeKey: string;
  op: "upsert" | "delete";
  generation: number;
  at: string;
}

/** Replaceable repository contract (§17.5). */
export interface MemoryRepository {
  get(tenantId: string, id: string): Promise<MemoryItem | null>;
  list(tenantId: string, filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>>;
  /** Idempotent by idempotencyKey within tenant. */
  create(tenantId: string, item: MemoryItem, idempotencyKey: string): Promise<{ item: MemoryItem; created: boolean }>;
  /** Compare-and-set on version; VERSION_CONFLICT otherwise. */
  update(tenantId: string, id: string, ifVersion: string, next: MemoryItem): Promise<MemoryItem>;
  /** Tombstones matching items; bumps and returns the deletion generation. */
  delete(tenantId: string, ids: string[], idempotencyKey: string): Promise<{ generation: number; count: number }>;
  /** Current deletion generation for a scope key; writers check it before writing. */
  generation(tenantId: string, scopeKey: string): Promise<number>;
  countActive(tenantId: string, scope: MemoryScope, kind: MemoryKind): Promise<number>;
  /** Drain outbox events (deduplicated into audit by core). */
  drainOutbox(max: number): Promise<MemoryOutboxEvent[]>;
  ackOutbox(ids: string[]): Promise<void>;
}

export interface MemoryIndex {
  upsert(tenantId: string, item: MemoryItem): Promise<void>;
  delete(tenantId: string, id: string, generation: number): Promise<void>;
  search(tenantId: string, scopeKey: string, text: string, maxItems: number): Promise<Array<{ id: string; version: string; score: number }>>;
  lagMs(): number;
}

export function scopeKey(scope: MemoryScope): string {
  // Structured tuples, safely encoded at the storage boundary (§9.2).
  switch (scope.kind) {
    case "subject":
      return JSON.stringify(["subject", scope.tenantId, scope.subjectId]);
    case "conversation":
      return JSON.stringify(["conversation", scope.tenantId, scope.conversationId]);
    case "entity":
      return JSON.stringify(["entity", scope.tenantId, scope.entityType, scope.entityId]);
  }
}
