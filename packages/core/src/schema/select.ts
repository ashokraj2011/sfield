/** `outputs.select` projection (§8.1): keeps named top-level fields, dot paths for nested objects. */
import type { JsonObject, JsonValue } from "../types/common.js";

export function applySelect(value: JsonValue, select: string[]): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: JsonObject = {};
  for (const path of select) {
    const parts = path.split(".");
    copyPath(value as JsonObject, out, parts);
  }
  return out;
}

function copyPath(src: JsonObject, dst: JsonObject, parts: string[]): void {
  const [head, ...rest] = parts;
  if (head === undefined || !Object.prototype.hasOwnProperty.call(src, head)) return;
  const v = src[head];
  if (rest.length === 0) {
    dst[head] = v as JsonValue;
    return;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const existing = dst[head];
  const target: JsonObject = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as JsonObject) : {};
  dst[head] = target;
  copyPath(v as JsonObject, target, rest);
}

export function validateSelectPaths(select: unknown): string | null {
  if (!Array.isArray(select) || select.length === 0) return "select must be a non-empty array of field paths";
  for (const p of select) {
    if (typeof p !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(p)) return `invalid select path ${JSON.stringify(p)}`;
    if (p.split(".").some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) return `invalid select path ${JSON.stringify(p)}`;
  }
  return null;
}
