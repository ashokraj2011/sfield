/** Ordered environment overrides (§5.2): dictionaries merge, arrays replace, null stays null, `$remove` deletes. */
import type { JsonObject, JsonValue } from "../types/common.js";
import { ConfigError } from "../errors.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function applyOverrides(base: JsonObject, overrides: JsonObject[], provenance: Record<string, string>): JsonObject {
  let current: JsonObject = base;
  overrides.forEach((doc, i) => {
    const label = `override[${i}]`;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError("INVALID_CONFIG", `${label} must be a mapping`, label);
    if (doc["includes"] !== undefined) throw new ConfigError("INVALID_CONFIG", `${label}: overrides cannot declare includes`, `${label}.includes`);
    current = merge(current, doc, "", label, provenance) as JsonObject;
  });
  return current;
}

function isRemove(v: JsonValue): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && (v as JsonObject)["$remove"] === true;
}

function merge(base: JsonValue, over: JsonValue, path: string, label: string, provenance: Record<string, string>): JsonValue {
  if (over && typeof over === "object" && !Array.isArray(over) && base && typeof base === "object" && !Array.isArray(base)) {
    const out: JsonObject = { ...(base as JsonObject) };
    for (const [k, v] of Object.entries(over)) {
      if (FORBIDDEN_KEYS.has(k)) throw new ConfigError("INVALID_CONFIG", `${label}: prototype-pollution key rejected`, `${path}.${k}`);
      const childPath = path ? `${path}.${k}` : k;
      if (isRemove(v)) {
        delete out[k];
        for (const p of Object.keys(provenance)) if (p === childPath || p.startsWith(`${childPath}.`)) delete provenance[p];
        continue;
      }
      out[k] = merge(out[k] as JsonValue, v, childPath, label, provenance);
    }
    return out;
  }
  if (isRemove(over)) return null;
  record(over, path, label, provenance);
  return over;
}

function record(value: JsonValue, path: string, label: string, provenance: Record<string, string>): void {
  for (const p of Object.keys(provenance)) if (p === path || p.startsWith(`${path}.`)) delete provenance[p];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) record(v, path ? `${path}.${k}` : k, label, provenance);
    return;
  }
  provenance[path] = label;
}
