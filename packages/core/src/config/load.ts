/** Parsing, includes, and `${env:NAME}` substitution (§5.2, §5.5, §18.5). */
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import type { JsonObject, JsonValue } from "../types/common.js";
import { ConfigError } from "../errors.js";
import { DICTIONARY_KEYS, ENV_SUBSTITUTABLE_PATHS, ROOT_KEYS } from "./root-schema.js";

export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
export const MAX_CONFIG_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface LoadedDocument {
  document: JsonObject;
  /** Provenance: dotted path -> source label. */
  provenance: Record<string, string>;
  files: string[];
  configDir: string;
}

export function parseDocumentText(text: string, label: string): JsonObject {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new ConfigError("INVALID_CONFIG", `${label} exceeds ${MAX_CONFIG_BYTES} bytes`, label, "Split the configuration with includes");
  }
  let value: unknown;
  try {
    value = parseYaml(text, {
      maxAliasCount: 100,
      uniqueKeys: true,
      customTags: [],
      schema: "core",
      strict: true,
      merge: false,
    });
  } catch (e) {
    throw new ConfigError("INVALID_CONFIG", `${label}: ${(e as Error).message.split("\n")[0]}`, label, "Fix the YAML/JSON syntax");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("INVALID_CONFIG", `${label}: document must be a mapping`, label);
  }
  checkKeys(value, label, 0);
  return value as JsonObject;
}

function checkKeys(value: unknown, path: string, depth: number): void {
  if (depth > MAX_CONFIG_DEPTH) throw new ConfigError("INVALID_CONFIG", `${path}: nesting exceeds ${MAX_CONFIG_DEPTH}`, path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkKeys(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new ConfigError("INVALID_CONFIG", `${path}.${k}: prototype-pollution key rejected`, `${path}.${k}`);
      checkKeys((value as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
    }
  }
}

/** Loads a file with deterministic include expansion; cycles and duplicate definitions are errors. */
export function loadConfigFile(file: string): LoadedDocument {
  const abs = resolve(file);
  const configDir = dirname(abs);
  const provenance: Record<string, string> = {};
  const files: string[] = [];
  const document = loadRecursive(abs, [], provenance, files, configDir);
  return { document, provenance, files, configDir };
}

export function loadConfigDocument(document: JsonObject, configDir: string, label = "config"): LoadedDocument {
  checkKeys(document, label, 0);
  const provenance: Record<string, string> = {};
  recordProvenance(document, "", label, provenance);
  const files: string[] = [];
  const merged = expandIncludes(document, configDir, label, [], provenance, files, configDir);
  return { document: merged, provenance, files, configDir };
}

function loadRecursive(abs: string, stack: string[], provenance: Record<string, string>, files: string[], configDir: string): JsonObject {
  if (stack.includes(abs)) {
    throw new ConfigError("INCLUDE_CYCLE", `include cycle: ${[...stack, abs].map((f) => relative(configDir, f)).join(" -> ")}`, relative(configDir, abs));
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    throw new ConfigError("INVALID_CONFIG", `cannot read ${relative(configDir, abs) || abs}: ${(e as Error).message}`, relative(configDir, abs) || abs, "Check the path relative to the configuration file");
  }
  files.push(abs);
  const label = relative(configDir, abs) || abs;
  const doc = parseDocumentText(text, label);
  recordProvenance(doc, "", label, provenance);
  return expandIncludes(doc, dirname(abs), label, [...stack, abs], provenance, files, configDir);
}

function expandIncludes(
  doc: JsonObject,
  baseDir: string,
  label: string,
  stack: string[],
  provenance: Record<string, string>,
  files: string[],
  configDir: string,
): JsonObject {
  for (const k of Object.keys(doc)) {
    if (!ROOT_KEYS.includes(k)) {
      throw new ConfigError("UNKNOWN_KEY", `${label}: unknown root key ${JSON.stringify(k)}`, k, `Root keys are ${ROOT_KEYS.join(", ")}; deployment and infrastructure belong to SField.create options`);
    }
  }
  const includes = doc["includes"];
  const out: JsonObject = { ...doc };
  delete out["includes"];
  if (includes === undefined) return out;
  if (!Array.isArray(includes) || !includes.every((i) => typeof i === "string")) {
    throw new ConfigError("INVALID_CONFIG", `${label}: includes must be an array of relative paths`, "includes");
  }
  for (const inc of includes as string[]) {
    if (isAbsolute(inc)) throw new ConfigError("INVALID_CONFIG", `${label}: include ${JSON.stringify(inc)} must be relative`, "includes");
    const abs = resolve(baseDir, inc);
    const included = loadRecursive(abs, stack.length ? stack : [resolve(baseDir, label)], provenance, files, configDir);
    if (included["version"] !== undefined && included["version"] !== out["version"]) {
      throw new ConfigError("INVALID_CONFIG", `include ${inc} declares version ${String(included["version"])}, expected ${String(out["version"])}`, `${inc}.version`);
    }
    for (const dict of DICTIONARY_KEYS) {
      const add = included[dict];
      if (add === undefined) continue;
      if (!add || typeof add !== "object" || Array.isArray(add)) throw new ConfigError("INVALID_CONFIG", `${inc}: ${dict} must be a mapping`, `${inc}.${dict}`);
      const existing = out[dict];
      const target: JsonObject = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as JsonObject) } : {};
      for (const [name, def] of Object.entries(add as JsonObject)) {
        if (Object.prototype.hasOwnProperty.call(target, name)) {
          throw new ConfigError("DUPLICATE_DEFINITION", `${dict}.${name} is defined more than once (${provenance[`${dict}.${name}`] ?? label} and ${inc})`, `${dict}.${name}`, "Includes combine named dictionaries; remove one definition");
        }
        target[name] = def;
      }
      out[dict] = target;
    }
  }
  return out;
}

function recordProvenance(value: JsonValue, path: string, label: string, provenance: Record<string, string>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) recordProvenance(v, path ? `${path}.${k}` : k, label, provenance);
    return;
  }
  provenance[path] = label;
}

const ENV_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split(".");
  const s = path.split(".");
  if (p.length !== s.length) return false;
  return p.every((seg, i) => seg === "*" || seg === s[i]);
}

/**
 * Substitutes `${env:NAME}` only in declared fields (§5.5). Any other occurrence is an error, including
 * instructions, tool operations, schemas, and model-visible fields.
 */
export function substituteEnv(
  doc: JsonObject,
  env: Record<string, string | undefined>,
  provenance: Record<string, string>,
  extraPatterns: string[] = [],
): JsonObject {
  const patterns = [...ENV_SUBSTITUTABLE_PATHS, ...extraPatterns];
  const walk = (value: JsonValue, path: string): JsonValue => {
    if (typeof value === "string") {
      if (!value.includes("${env:")) return value;
      if (!patterns.some((p) => pathMatches(p, path))) {
        throw new ConfigError("INVALID_CONFIG", `${path}: \${env:NAME} substitution is not permitted here`, path, `Substitution is allowed only in ${patterns.join(", ")}; secrets use credential: {env: NAME}`);
      }
      const out = value.replace(ENV_RE, (_m, name: string) => {
        const v = env[name];
        if (v === undefined) {
          throw new ConfigError("MISSING_ENVIRONMENT", `${path}: environment variable ${name} is not set`, path, `Set ${name} in the environment or .env`);
        }
        provenance[path] = `env:${name}`;
        return v;
      });
      return out;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, path ? `${path}.${k}` : k);
      return out;
    }
    return value;
  };
  return walk(doc, "") as JsonObject;
}
