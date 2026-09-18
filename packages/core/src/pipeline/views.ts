/** Canonical result vs model view (§9.6, §12.5). */
import type { JsonValue } from "../types/common.js";

export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Bounded excerpt labeled partial; the canonical result stays intact. */
export function shortenForModel(value: JsonValue, limitBytes: number): { content: JsonValue; partial: boolean } {
  const text = JSON.stringify(value) ?? "null";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limitBytes) return { content: value, partial: false };
  const budget = Math.max(64, limitBytes - 160);
  let cut = text.slice(0, budget);
  // Avoid splitting a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { content: { partial: true, bytes, excerpt: cut, note: "result shortened for the model view; the complete canonical result is stored in the run record" }, partial: true };
}
