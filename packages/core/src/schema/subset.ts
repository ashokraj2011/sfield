/** Supported JSON Schema draft 2020-12 subset (§8.2). */
import type { JsonSchema } from "../types/common.js";
import { FORMATS } from "./formats.js";

export interface SchemaIssue {
  path: string;
  code: "UNSUPPORTED_SCHEMA" | "INVALID_CONFIG";
  message: string;
  suggestion?: string;
}

const ALLOWED_KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "$comment",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "format",
  "description",
  "title",
  "default",
  "examples",
  "anyOf",
  "deprecated",
]);

const ALLOWED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_DEPTH = 32;
const MAX_NODES = 2000;
const MAX_PATTERN = 512;

export interface SubsetOptions {
  /** Every object must close additionalProperties (always true for tool input/output schemas). */
  requireClosedObjects?: boolean;
  path?: string;
}

/** Returns issues; an empty list means the schema is inside the supported subset. */
export function checkSchemaSubset(schema: unknown, opts: SubsetOptions = {}): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const state = { nodes: 0 };
  const defs = new Set<string>();
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const d = (schema as JsonSchema)["$defs"];
    if (d && typeof d === "object" && !Array.isArray(d)) for (const k of Object.keys(d)) defs.add(k);
  }
  walk(schema, opts.path ?? "schema", 0, issues, state, defs, opts.requireClosedObjects ?? true, true);
  return issues;
}

function walk(
  node: unknown,
  path: string,
  depth: number,
  issues: SchemaIssue[],
  state: { nodes: number },
  defs: Set<string>,
  closed: boolean,
  isRoot: boolean,
): void {
  state.nodes++;
  if (state.nodes > MAX_NODES) {
    if (state.nodes === MAX_NODES + 1) issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: `schema exceeds ${MAX_NODES} nodes` });
    return;
  }
  if (depth > MAX_DEPTH) {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: `schema nesting exceeds ${MAX_DEPTH}` });
    return;
  }
  if (typeof node === "boolean") {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: "boolean schemas are not supported", suggestion: "Use an explicit object schema" });
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: "schema must be an object" });
    return;
  }
  const s = node as JsonSchema;
  for (const key of Object.keys(s)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      issues.push({ path: `${path}.${key}`, code: "INVALID_CONFIG", message: "prototype-pollution key rejected" });
      continue;
    }
    if (!ALLOWED_KEYWORDS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: "UNSUPPORTED_SCHEMA",
        message: `keyword ${JSON.stringify(key)} is outside the supported subset`,
        suggestion: "Supported: closed objects, arrays, strings, booleans, null, numbers, enum/const, required, bounds, local $defs references, nullable unions",
      });
    }
  }
  if (s["$defs"] !== undefined && !isRoot) {
    issues.push({ path: `${path}.$defs`, code: "UNSUPPORTED_SCHEMA", message: "$defs is only permitted at the schema root" });
  }
  if (typeof s["$ref"] === "string") {
    const ref = s["$ref"];
    const m = /^#\/\$defs\/([A-Za-z0-9_.-]+)$/.exec(ref);
    if (!m) {
      issues.push({ path: `${path}.$ref`, code: "UNSUPPORTED_SCHEMA", message: `only local bundled references (#/$defs/name) are supported, got ${JSON.stringify(ref)}`, suggestion: "Network schema references are disabled" });
    } else if (!defs.has(m[1]!)) {
      issues.push({ path: `${path}.$ref`, code: "INVALID_CONFIG", message: `reference to undefined $defs entry ${JSON.stringify(m[1])}` });
    }
    return;
  }
  if (s["$defs"] !== undefined) {
    const d = s["$defs"];
    if (!d || typeof d !== "object" || Array.isArray(d)) issues.push({ path: `${path}.$defs`, code: "UNSUPPORTED_SCHEMA", message: "$defs must be an object" });
    else for (const [k, v] of Object.entries(d)) walk(v, `${path}.$defs.${k}`, depth + 1, issues, state, defs, closed, false);
  }
  if (s["anyOf"] !== undefined) {
    const arr = s["anyOf"];
    const ok =
      Array.isArray(arr) &&
      arr.length === 2 &&
      arr.filter((m) => m && typeof m === "object" && (m as JsonSchema)["type"] === "null").length === 1;
    if (!ok) {
      issues.push({ path: `${path}.anyOf`, code: "UNSUPPORTED_SCHEMA", message: "anyOf is supported only as a nullable union: [<schema>, {type: null}]" });
    } else {
      for (const [i, m] of (arr as unknown[]).entries()) walk(m, `${path}.anyOf[${i}]`, depth + 1, issues, state, defs, closed, false);
    }
    return;
  }
  const type = s["type"];
  let types: string[] = [];
  if (typeof type === "string") types = [type];
  else if (Array.isArray(type)) {
    types = type as string[];
    if (!(types.length === 2 && types[1] === "null" && types[0] !== "null")) {
      issues.push({ path: `${path}.type`, code: "UNSUPPORTED_SCHEMA", message: "type arrays are supported only as [<type>, \"null\"]" });
    }
  } else if (type !== undefined) {
    issues.push({ path: `${path}.type`, code: "UNSUPPORTED_SCHEMA", message: "type must be a string or [type, \"null\"]" });
  } else if (s["enum"] === undefined && s["const"] === undefined) {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: "every schema needs a type, enum, or const", suggestion: "Declare type explicitly" });
  }
  for (const t of types) {
    if (!ALLOWED_TYPES.has(t)) issues.push({ path: `${path}.type`, code: "UNSUPPORTED_SCHEMA", message: `unsupported type ${JSON.stringify(t)}` });
  }
  if (types.includes("object")) {
    const props = s["properties"];
    if (props !== undefined && (typeof props !== "object" || props === null || Array.isArray(props))) {
      issues.push({ path: `${path}.properties`, code: "UNSUPPORTED_SCHEMA", message: "properties must be an object" });
    }
    if (closed && s["additionalProperties"] !== false) {
      issues.push({
        path: `${path}.additionalProperties`,
        code: "UNSUPPORTED_SCHEMA",
        message: "every object must explicitly close additional properties",
        suggestion: "Add additionalProperties: false",
      });
    } else if (s["additionalProperties"] !== undefined && s["additionalProperties"] !== false) {
      issues.push({ path: `${path}.additionalProperties`, code: "UNSUPPORTED_SCHEMA", message: "additionalProperties must be false" });
    }
    const propNames = new Set<string>();
    if (props && typeof props === "object") {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") {
          issues.push({ path: `${path}.properties.${k}`, code: "INVALID_CONFIG", message: "prototype-pollution key rejected" });
          continue;
        }
        propNames.add(k);
        walk(v, `${path}.properties.${k}`, depth + 1, issues, state, defs, closed, false);
      }
    }
    if (s["required"] !== undefined) {
      if (!Array.isArray(s["required"]) || !(s["required"] as unknown[]).every((r) => typeof r === "string")) {
        issues.push({ path: `${path}.required`, code: "UNSUPPORTED_SCHEMA", message: "required must be an array of strings" });
      } else {
        for (const r of s["required"] as string[]) {
          if (!propNames.has(r)) issues.push({ path: `${path}.required`, code: "INVALID_CONFIG", message: `required property ${JSON.stringify(r)} is not declared in properties` });
        }
      }
    }
  } else if (s["properties"] !== undefined || s["required"] !== undefined || s["additionalProperties"] !== undefined) {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: "object keywords require type: object" });
  }
  if (types.includes("array")) {
    if (s["items"] === undefined) issues.push({ path: `${path}.items`, code: "UNSUPPORTED_SCHEMA", message: "arrays must declare items" });
    else walk(s["items"], `${path}.items`, depth + 1, issues, state, defs, closed, false);
  } else if (s["items"] !== undefined) {
    issues.push({ path, code: "UNSUPPORTED_SCHEMA", message: "items requires type: array" });
  }
  if (typeof s["pattern"] === "string") {
    if (s["pattern"].length > MAX_PATTERN) issues.push({ path: `${path}.pattern`, code: "UNSUPPORTED_SCHEMA", message: `pattern longer than ${MAX_PATTERN} characters` });
    else {
      try {
        new RegExp(s["pattern"], "u");
      } catch {
        issues.push({ path: `${path}.pattern`, code: "INVALID_CONFIG", message: "pattern is not a valid regular expression" });
      }
    }
  }
  if (s["format"] !== undefined) {
    if (typeof s["format"] !== "string" || !Object.prototype.hasOwnProperty.call(FORMATS, s["format"])) {
      issues.push({ path: `${path}.format`, code: "UNSUPPORTED_SCHEMA", message: `unsupported format ${JSON.stringify(s["format"])}`, suggestion: `Supported formats: ${Object.keys(FORMATS).join(", ")}` });
    }
  }
  if (s["enum"] !== undefined && (!Array.isArray(s["enum"]) || (s["enum"] as unknown[]).length === 0)) {
    issues.push({ path: `${path}.enum`, code: "UNSUPPORTED_SCHEMA", message: "enum must be a non-empty array" });
  }
}
