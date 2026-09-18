import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./jcs.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:<hex>` over the JCS encoding of a value. */
export function digestJson(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfter(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}
