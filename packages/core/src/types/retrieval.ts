/** Retrieval source contracts (§11). */
import type { BindingIdentity, DataClassification, JsonValue, Principal } from "./common.js";

export interface RetrievalQuery {
  principal: Principal;
  text: string;
  filters: Readonly<Record<string, JsonValue>>;
  maxItems: number;
  maxBytes: number;
  signal: AbortSignal;
}

export interface RetrievedItem {
  id: string;
  sourceId: string;
  sourceVersion: string;
  title?: string;
  text: string;
  citation: { label: string; uri?: string; locator?: string };
  classification: DataClassification;
  observedAt: string;
  validUntil?: string;
  score?: number;
  aclEvidence: string;
}

export interface RetrievalBinding {
  identity: BindingIdentity;
  search(query: RetrievalQuery): Promise<{ items: RetrievedItem[]; partial: boolean }>;
  authorizeItem(item: RetrievedItem, principal: Principal): Promise<boolean>;
}

/** A registered retrieval type builds bindings from validated shorthand config (§5.5). */
export interface RetrievalTypeFactory {
  type: string;
  configSchema: Record<string, unknown>;
  /** Fields allowed to carry `${env:NAME}` substitution. */
  substitutableFields?: string[];
  create(sourceId: string, config: Record<string, JsonValue>, ctx: { configDir: string }): RetrievalBinding;
}
