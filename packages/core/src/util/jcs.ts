/** JSON Canonicalization Scheme (RFC 8785). */
import type { JsonValue } from "../types/common.js";

export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join("");
}

function write(value: unknown, out: string[], depth: number): void {
  if (depth > 256) throw new Error("JCS: nesting too deep");
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
      out.push(Object.is(value, -0) ? "0" : JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "bigint":
      out.push(JSON.stringify(value.toString()));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          write(value[i], out, depth + 1);
        }
        out.push("]");
        return;
      }
      if (value instanceof Date) {
        out.push(JSON.stringify(value.toISOString()));
        return;
      }
      const obj = value as Record<string, unknown>;
      // Sort by UTF-16 code units (RFC 8785 §3.2.3); default string comparison does exactly that.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
        .sort();
      out.push("{");
      let first = true;
      for (const k of keys) {
        if (!first) out.push(",");
        first = false;
        out.push(JSON.stringify(k), ":");
        write(obj[k], out, depth + 1);
      }
      out.push("}");
      return;
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
}

/** Returns a structurally canonical copy (sorted keys) as a JsonValue. */
export function canonicalValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}
