/** Context manager contracts (§12). */
import type { AttachmentRef, DataClassification, JsonObject } from "./common.js";
import type { ExposedTool } from "./tool.js";

export type ContextBlockKind =
  | "instruction"
  | "current_message"
  | "history"
  | "summary"
  | "preference"
  | "fact"
  | "retrieval"
  | "tool_result"
  | "attachment";

export type ContextAuthority = "host_instruction" | "user_input" | "reference_data";

export type ProviderNeutralContent =
  | { type: "text"; text: string }
  | { type: "media"; ref: AttachmentRef; text?: string }
  | { type: "opaque"; provider: string; block: JsonObject };

export interface ContextBlock {
  id: string;
  kind: ContextBlockKind;
  sourceIds: string[];
  authority: ContextAuthority;
  classification: DataClassification;
  content: ProviderNeutralContent;
  tokens: number;
  required: boolean;
  freshness: "current" | "stale" | "unknown";
  /** Priority category used for allocation (§12.4). */
  category?: "history" | "preferences" | "facts" | "retrieval" | "summary";
  rank?: number;
  citationId?: string;
  label?: string;
  /** Internal: transcript reference for tool-result blocks that may be shortened. */
  toolResultRef?: string;
  /** Internal: this block is a shortened view of another block (its id is the last sourceId). */
  shortened?: boolean;
}

export interface CitationTarget {
  sourceId: string;
  itemId: string;
  label: string;
  uri?: string;
  locator?: string;
}

export interface ContextPacket {
  id: string;
  runId: string;
  modelBindingDigest: string;
  blocks: ContextBlock[];
  tools: ExposedTool[];
  budget: { inputLimit: number; outputReserve: number; estimatedInput: number; estimated: boolean; safetyMargin: number };
  omissions: Array<{ sourceId: string; reason: string; blockId?: string; tokens?: number }>;
  transformations: Array<{ type: string; sourceIds: string[]; resultId: string }>;
  citations: Record<string, CitationTarget>;
  digest: string;
}

export interface ContextExplanation {
  contextId: string;
  runId: string;
  agentId: string;
  tenantId: string;
  createdAt: string;
  budget: ContextPacket["budget"];
  included: Array<{
    blockId: string;
    kind: ContextBlockKind;
    sourceIds: string[];
    authorization: "allowed" | "not_required";
    freshness: ContextBlock["freshness"];
    tokens: number;
    rank?: number;
    transformation?: string;
  }>;
  omitted: Array<{ sourceId: string; reason: string; blockId?: string; tokens?: number }>;
  tools: Array<{ ref: string; alias: string; tokens: number; builtin: boolean }>;
  transformations: ContextPacket["transformations"];
}
