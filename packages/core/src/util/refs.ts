/** Typed reference resolution (§5.3): dot properties and fixed indices only. */
import type { JsonObject, JsonValue, ValueBinding } from "../types/common.js";
import { SFieldError } from "../errors.js";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export interface ParsedRef {
  root: string;
  segments: Array<string | number>;
}

export function parseRefPath(path: string): ParsedRef {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) {
    throw new SFieldError("INVALID_REFERENCE", `invalid reference path ${JSON.stringify(path)}`, { suggestion: "Use dot-separated property names, e.g. inputs.customer_id" });
  }
  if (/[()${}*?<>|&!=+\-\/%'"\\`,;:\s]/.test(path)) {
    throw new SFieldError("INVALID_REFERENCE", `reference ${JSON.stringify(path)} contains an operator, call, wildcard, or whitespace`, {
      suggestion: "Computation belongs in a registered transform or custom tool; references may only look values up",
    });
  }
  const parts = path.split(".");
  const segments: Array<string | number> = [];
  for (const part of parts) {
    if (part === "") throw new SFieldError("INVALID_REFERENCE", `reference ${JSON.stringify(path)} has an empty segment`);
    // property[index] form
    const m = /^([A-Za-z_][A-Za-z0-9_]*)?((?:\[[0-9]+\])+)$/.exec(part);
    if (m) {
      if (m[1]) segments.push(m[1]);
      for (const idx of m[2]!.matchAll(/\[([0-9]+)\]/g)) segments.push(Number(idx[1]));
      continue;
    }
    if (/^[0-9]+$/.test(part)) {
      segments.push(Number(part));
      continue;
    }
    if (!IDENT_RE.test(part) || FORBIDDEN.has(part)) {
      throw new SFieldError("INVALID_REFERENCE", `reference segment ${JSON.stringify(part)} in ${JSON.stringify(path)} is not allowed`);
    }
    segments.push(part);
  }
  const root = segments[0];
  if (typeof root !== "string") throw new SFieldError("INVALID_REFERENCE", `reference ${JSON.stringify(path)} must start with a named root`);
  return { root, segments: segments.slice(1) };
}

export const OMIT: unique symbol = Symbol("omit");

export type ResolvedValue = JsonValue | typeof OMIT;

export function lookup(root: JsonValue | undefined, segments: Array<string | number>): JsonValue | undefined {
  let cur: JsonValue | undefined = root;
  for (const seg of segments) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as JsonObject)[seg];
    }
  }
  return cur;
}

/**
 * Resolves a ValueBinding against named roots. Missing values fail unless `onMissing: omit` is allowed
 * for the field. Empty strings and null are not missing.
 */
export function resolveBinding(
  binding: ValueBinding,
  roots: Record<string, JsonValue | undefined>,
  opts: { field: string; allowOmit: boolean; allowedRoots?: string[] },
): ResolvedValue {
  if ("literal" in binding) return binding.literal;
  const parsed = parseRefPath(binding.ref);
  const allowed = opts.allowedRoots ?? Object.keys(roots);
  if (!allowed.includes(parsed.root)) {
    throw new SFieldError("INVALID_REFERENCE", `reference root ${JSON.stringify(parsed.root)} is not allowed for ${opts.field}`, {
      suggestion: `Allowed roots: ${allowed.join(", ")}`,
    });
  }
  const value = lookup(roots[parsed.root], parsed.segments);
  if (value === undefined) {
    if (binding.onMissing === "omit") {
      if (!opts.allowOmit) {
        throw new SFieldError("INVALID_REFERENCE", `${opts.field} does not permit onMissing: omit`);
      }
      return OMIT;
    }
    throw new SFieldError("MISSING_REFERENCE", `reference ${JSON.stringify(binding.ref)} for ${opts.field} resolved to nothing`, {
      suggestion: "Provide the value or declare onMissing: omit where the operation permits it",
    });
  }
  return value;
}

/** Validates a binding's path shape and root at compile time. */
export function checkBinding(binding: unknown, allowedRoots: string[], path: string): string | null {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return `${path}: expected {literal} or {ref}`;
  const b = binding as Record<string, unknown>;
  if ("literal" in b) return Object.keys(b).length === 1 ? null : `${path}: literal binding accepts no other keys`;
  if (typeof b["ref"] !== "string") return `${path}: expected {ref: string}`;
  for (const k of Object.keys(b)) if (k !== "ref" && k !== "onMissing") return `${path}: unknown key ${k}`;
  if (b["onMissing"] !== undefined && b["onMissing"] !== "error" && b["onMissing"] !== "omit") return `${path}.onMissing: must be error or omit`;
  try {
    const parsed = parseRefPath(b["ref"]);
    if (!allowedRoots.includes(parsed.root)) return `${path}: root ${JSON.stringify(parsed.root)} not allowed (allowed: ${allowedRoots.join(", ")})`;
  } catch (e) {
    return `${path}: ${(e as Error).message}`;
  }
  return null;
}
