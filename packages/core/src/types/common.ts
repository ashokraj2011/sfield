/** Common value and identity types (§7.1). */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export const CLASSIFICATION_ORDER: Readonly<Record<DataClassification, number>> = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
});

export const CLASSIFICATIONS: readonly DataClassification[] = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export function isClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLASSIFICATION_ORDER, value);
}

export function maxClassification(a: DataClassification, b: DataClassification): DataClassification {
  return CLASSIFICATION_ORDER[a] >= CLASSIFICATION_ORDER[b] ? a : b;
}

/** True when `data` may flow to a destination that accepts up to `accepts`. */
export function classificationAllowed(data: DataClassification, accepts: DataClassification): boolean {
  return CLASSIFICATION_ORDER[data] <= CLASSIFICATION_ORDER[accepts];
}

/** Host-authenticated identity. Nothing in a request body can set it (§2 principle 5). */
export interface Principal {
  tenantId: string;
  subjectId: string;
  roles: readonly string[];
  attributes: Readonly<Record<string, string>>;
}

/** An authenticated actor making an approval or input decision. */
export interface Actor {
  tenantId: string;
  subjectId: string;
  roles?: readonly string[];
}

export interface AttachmentRef {
  id: string;
  digest: string;
  mediaType: string;
  bytes: number;
  classification: DataClassification;
  name?: string;
}

export interface MessageInput {
  text: string;
  attachments?: AttachmentRef[];
}

export interface SendRequest {
  message: MessageInput;
  inputs?: JsonObject;
  /** Generated when omitted; see RunHandle.idempotencyKey. */
  idempotencyKey?: string;
}

/** Typed value reference (§5.3). No expression language. */
export type ValueBinding =
  | { literal: JsonValue }
  | { ref: string; onMissing?: "error" | "omit" };

export function isValueBinding(v: unknown): v is ValueBinding {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.includes("literal")) return keys.every((k) => k === "literal");
  if (typeof o["ref"] === "string") {
    return keys.every((k) => k === "ref" || k === "onMissing");
  }
  return false;
}

export interface BindingIdentity {
  id: string;
  revision: string;
  accountScope: string;
  classification: DataClassification;
}

export type Effect = "read" | "write" | "destructive";
export type RetrySafety = "never" | "repeatable" | "deduplicated";

export interface ArtifactRef {
  id: string;
  digest: string;
  bytes: number;
  mediaType: string;
  classification: DataClassification;
}

export type ErrorCategory =
  | "configuration"
  | "validation"
  | "authorization"
  | "availability"
  | "accounting"
  | "coordination"
  | "effect_uncertainty"
  | "request_identity"
  | "internal";

export interface PublicError {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  runId?: string;
  callId?: string;
  path?: string;
  suggestion?: string;
}

/** Secret reference: never a value (§5.5, §18.2). */
export type SecretRef = { env: string } | { name: string };

export function isSecretRef(v: unknown): v is SecretRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length === 1 && (typeof o["env"] === "string" || typeof o["name"] === "string");
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  partial?: boolean;
}
