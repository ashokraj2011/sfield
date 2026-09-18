/** Local schema validation over the supported subset, always required (§8.2). */
import AjvModule from "ajv/dist/2020.js";
import type { Ajv2020 as Ajv2020Class, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

// ajv ships CommonJS; under Node ESM interop the default import may be the module namespace.
const Ajv2020 = (((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown) as typeof Ajv2020Class;
import type { JsonObject, JsonSchema, JsonValue } from "../types/common.js";
import { digestJson } from "../util/digest.js";
import { FORMATS, FORMATS_VERSION } from "./formats.js";
import { checkSchemaSubset, type SchemaIssue } from "./subset.js";

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
}

export const SCHEMA_COMPILER_VERSION = `ajv2020+${FORMATS_VERSION}`;

export class SchemaValidator {
  private readonly ajv: Ajv2020Class;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      allowUnionTypes: true,
      useDefaults: false,
      coerceTypes: false,
      removeAdditional: false,
      validateSchema: true,
      $data: false,
    });
    for (const [name, fn] of Object.entries(FORMATS)) this.ajv.addFormat(name, { type: "string", validate: fn });
  }

  /** Subset check plus Ajv compilation; returns issues without throwing. */
  check(schema: unknown, opts: { path?: string; requireClosedObjects?: boolean } = {}): SchemaIssue[] {
    const issues = checkSchemaSubset(schema, opts);
    if (issues.length > 0) return issues;
    try {
      this.compile(schema as JsonSchema);
    } catch (e) {
      issues.push({ path: opts.path ?? "schema", code: "UNSUPPORTED_SCHEMA", message: `schema failed to compile: ${(e as Error).message}` });
    }
    return issues;
  }

  compile(schema: JsonSchema): ValidateFunction {
    const key = digestJson(schema);
    let fn = this.cache.get(key);
    if (!fn) {
      fn = this.ajv.compile(schema);
      this.cache.set(key, fn);
    }
    return fn;
  }

  validate(schema: JsonSchema, value: unknown): ValidationResult {
    const fn = this.compile(schema);
    const ok = fn(value) as boolean;
    if (ok) return { ok: true, errors: [] };
    return { ok: false, errors: (fn.errors ?? []).map(formatError) };
  }

  /**
   * Inserts declared defaults for missing optional properties (recorded, never coerced). Returns the
   * paths that were inserted. Only object property defaults are applied (§8.2).
   */
  applyDefaults(schema: JsonSchema, value: JsonValue): { value: JsonValue; inserted: string[] } {
    const inserted: string[] = [];
    const out = insertDefaults(schema, value, "", inserted, schema);
    return { value: out, inserted };
  }
}

function insertDefaults(schema: JsonSchema, value: JsonValue, path: string, inserted: string[], root: JsonSchema): JsonValue {
  let s = schema;
  if (typeof s["$ref"] === "string") {
    const name = s["$ref"].replace("#/$defs/", "");
    const defs = root["$defs"] as Record<string, JsonSchema> | undefined;
    s = defs?.[name] ?? s;
  }
  if (s["type"] !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const props = (s["properties"] ?? {}) as Record<string, JsonSchema>;
  const obj: JsonObject = { ...(value as JsonObject) };
  for (const [k, ps] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      if (ps["default"] !== undefined) {
        obj[k] = JSON.parse(JSON.stringify(ps["default"])) as JsonValue;
        inserted.push(path ? `${path}.${k}` : k);
      }
      continue;
    }
    obj[k] = insertDefaults(ps, obj[k] as JsonValue, path ? `${path}.${k}` : k, inserted, root);
  }
  return obj;
}

function formatError(e: ErrorObject): ValidationIssue {
  const path = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
  let message = e.message ?? e.keyword;
  if (e.keyword === "additionalProperties" && e.params && typeof e.params["additionalProperty"] === "string") {
    message = `unexpected property ${JSON.stringify(e.params["additionalProperty"])}`;
  } else if (e.keyword === "required" && e.params && typeof e.params["missingProperty"] === "string") {
    message = `missing required property ${JSON.stringify(e.params["missingProperty"])}`;
  }
  return { path: path || "$", keyword: e.keyword, message };
}

/** Singleton for core use; hosts may construct their own. */
let shared: SchemaValidator | undefined;
export function sharedValidator(): SchemaValidator {
  if (!shared) shared = new SchemaValidator();
  return shared;
}
