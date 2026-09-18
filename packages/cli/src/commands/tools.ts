import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { SField, digestJson } from "@sfield/core";
import type { JsonObject, JsonValue } from "@sfield/core";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { loadWiring } from "../wiring.js";
import { eprintln, formatPublic, println, printJson, table } from "../output.js";
import { openField } from "./shared.js";

export async function toolsList(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    const list = sf.registry.list();
    if (flagBool(args.flags, "json")) printJson(list);
    else println(table([["REF", "EFFECT", "ADAPTER", "SOURCE", "DESCRIPTION"], ...list.map((t) => [t.ref, t.policy.effect, t.adapter, t.source, t.description.slice(0, 60)])]));
  } finally {
    await sf.close();
  }
  return 0;
}

export async function toolsDescribe(args: ParsedArgs): Promise<number> {
  const ref = args.positionals[2];
  if (!ref) {
    println("usage: sfield tools describe <id@version>");
    return 2;
  }
  const sf = await openField(args);
  try {
    printJson(sf.registry.describe(ref));
  } finally {
    await sf.close();
  }
  return 0;
}

export async function toolsExport(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    const out = resolve(process.cwd(), flagString(args.flags, "out") ?? "catalog.json");
    const catalog = { exportedAt: new Date().toISOString(), configDigest: sf.config.digest(), tools: sf.registry.list() };
    writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
    println(`wrote ${out} (${catalog.tools.length} tools)`);
  } finally {
    await sf.close();
  }
  return 0;
}

/** `sfield tools add [--manifest file]`: validated `tools.<id>` entry written into sfield.yaml (§8.6). */
export async function toolsAdd(args: ParsedArgs): Promise<number> {
  const configPath = resolve(process.cwd(), flagString(args.flags, "config") ?? "sfield.yaml");
  if (!existsSync(configPath)) {
    eprintln(`configuration file ${configPath} not found`);
    return 1;
  }
  const manifestPath = flagString(args.flags, "manifest");
  const manifest = manifestPath ? (parseYaml(readFileSync(resolve(process.cwd(), manifestPath), "utf8")) as JsonObject) : await wizard(configPath);
  if (!manifest) return 1;
  const id = String(manifest["id"] ?? "");
  if (!id) {
    eprintln("manifest needs an id");
    return 1;
  }
  const entry: JsonObject = { ...manifest };
  delete entry["id"];
  if (entry["adapter"] === undefined) entry["adapter"] = "http";
  const policy = (entry["policy"] as JsonObject | undefined) ?? {};
  const effect = String(policy["effect"] ?? "");
  if (effect === "write" || effect === "destructive") {
    // Mutations need a retry contract and deduplication, or explicit approval (§8.6).
    if (!(policy["retry_safety"] && policy["retry_safety"] !== "never") || !entry["deduplication"]) {
      policy["requires_approval"] = true;
      eprintln(`note: ${id} is a ${effect} tool without a deduplication contract; marked requires_approval: true`);
    }
    entry["policy"] = policy;
  }
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (doc.getIn(["tools", id]) !== undefined) {
    eprintln(`tools.${id} already exists in ${configPath}`);
    return 1;
  }
  const candidate = doc.clone();
  candidate.setIn(["tools", id], entry as unknown as JsonValue);
  const wiring = await loadWiring(args, { requireConfig: false });
  const report = await SField.validate({ ...wiring.options, config: candidate.toJS() as JsonObject, configDir: resolve(configPath, "..") });
  if (!report.ok) {
    eprintln(`the new tool does not validate:`);
    for (const e of report.errors) eprintln(`  ${formatPublic(e)}`);
    return 1;
  }
  writeFileSync(configPath, candidate.toString());
  println(`added tools.${id} to ${configPath}; new digest ${report.digest}`);
  return 0;
}

async function ask(rl: readline.Interface, q: string, def?: string): Promise<string> {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || "";
}

async function wizard(configPath: string): Promise<JsonObject | null> {
  if (!process.stdin.isTTY) {
    eprintln("no terminal: pass --manifest <file> (fields: id, version, description, connection, operation, inputs, outputs, resource, policy, deduplication)");
    return null;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const existing = parseYaml(readFileSync(configPath, "utf8")) as JsonObject;
    const connections = Object.keys((existing["connections"] as JsonObject | undefined) ?? {});
    eprintln(`connections: ${connections.join(", ") || "none"}`);
    const id = await ask(rl, "tool id (lowercase.dot.separated)");
    const version = await ask(rl, "version", "1.0.0");
    const description = await ask(rl, "description");
    let connection = await ask(rl, "connection", connections[0]);
    let newConnection: JsonObject | undefined;
    if (!connections.includes(connection)) {
      const base_url = await ask(rl, `base_url for new connection ${connection}`);
      const envName = await ask(rl, "credential environment variable (bearer token)");
      newConnection = { base_url, auth: { type: "bearer", credential: { env: envName } } };
    }
    const method = (await ask(rl, "HTTP method", "GET")).toUpperCase();
    const path_template = await ask(rl, "path template, e.g. /customers/{customer_id}");
    const inputs = JSON.parse(await ask(rl, "inputs JSON Schema (closed object)", '{"type":"object","additionalProperties":false,"properties":{}}')) as JsonObject;
    const outputs = JSON.parse(await ask(rl, "outputs JSON Schema (closed object; add \"select\": [...] to keep only named fields)", '{"type":"object","additionalProperties":false,"properties":{}}')) as JsonObject;
    const effect = await ask(rl, "effect (read | write | destructive)", method === "GET" ? "read" : "write");
    const action = await ask(rl, "authorization action", id);
    const resourceType = await ask(rl, "resource type", effect === "read" ? "" : "order");
    const resourceRef = resourceType ? await ask(rl, "resource id reference (inputs.<field>)") : "";
    const params = [...path_template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
    const operation: JsonObject = { method, path_template, response: "json" };
    if (params.length) operation["path_params"] = Object.fromEntries(params.map((p) => [p, { ref: `inputs.${p}` }]));
    if (method !== "GET" && method !== "DELETE") {
      const props = Object.keys((inputs["properties"] as JsonObject | undefined) ?? {}).filter((p) => !params.includes(p));
      operation["body"] = { fields: Object.fromEntries(props.map((p) => [p, { ref: `inputs.${p}` }])) };
    }
    const manifest: JsonObject = { id, version, description, adapter: "http", connection, operation, inputs, outputs, policy: { effect, action } };
    if (resourceType) manifest["resource"] = { type: resourceType, id: { ref: resourceRef } };
    if (effect !== "read") {
      const dedup = await ask(rl, "deduplication header name (empty = require approval instead)", "");
      if (dedup) {
        (manifest["policy"] as JsonObject)["retry_safety"] = "deduplicated";
        (manifest["policy"] as JsonObject)["max_attempts"] = 2;
        manifest["deduplication"] = { key_location: { header: dedup }, scope: connection, retention_seconds: 604800, payload_mismatch: "reject" };
      } else (manifest["policy"] as JsonObject)["requires_approval"] = true;
    }
    if (newConnection) {
      const doc = parseDocument(readFileSync(configPath, "utf8"));
      doc.setIn(["connections", connection], newConnection as unknown as JsonValue);
      writeFileSync(configPath, doc.toString());
      eprintln(`added connections.${connection}`);
    }
    eprintln(`manifest:\n${stringifyYaml(manifest)}`);
    return manifest;
  } finally {
    rl.close();
  }
}

/** `sfield tools import --source openapi --file spec --out candidates.yaml`: non-executable candidates (§8.4). */
export async function toolsImport(args: ParsedArgs): Promise<number> {
  const source = flagString(args.flags, "source") ?? "openapi";
  const file = flagString(args.flags, "file");
  if (source !== "openapi" || !file) {
    println("usage: sfield tools import --source openapi --file spec.yaml [--out candidates.yaml] [--connection NAME]");
    return 2;
  }
  const spec = parseYaml(readFileSync(resolve(process.cwd(), file), "utf8")) as JsonObject;
  const paths = (spec["paths"] as JsonObject | undefined) ?? {};
  const components = ((spec["components"] as JsonObject | undefined)?.["schemas"] as JsonObject | undefined) ?? {};
  const connection = flagString(args.flags, "connection") ?? "api";
  const candidates: Record<string, JsonObject> = {};
  const notes: string[] = [];
  for (const [path, ops] of Object.entries(paths)) {
    for (const [method, opRaw] of Object.entries((ops as JsonObject) ?? {})) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const op = opRaw as JsonObject;
      const id = (typeof op["operationId"] === "string" ? op["operationId"] : `${method}_${path}`).replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/_+/g, ".").replace(/^\.|\.$/g, "").toLowerCase() || `${method}.${path.replace(/[^a-z0-9]+/gi, ".")}`;
      const properties: JsonObject = {};
      const required: string[] = [];
      const pathParams: JsonObject = {};
      const query: JsonObject = {};
      for (const p of ((op["parameters"] as JsonObject[] | undefined) ?? []).concat(((ops as JsonObject)["parameters"] as JsonObject[] | undefined) ?? [])) {
        const name = String(p["name"]);
        properties[name] = deref((p["schema"] as JsonObject | undefined) ?? { type: "string" }, components, notes, `${id}.${name}`);
        if (p["required"] === true || p["in"] === "path") required.push(name);
        if (p["in"] === "path") pathParams[name] = { ref: `inputs.${name}` };
        else if (p["in"] === "query") query[name] = { ref: `inputs.${name}`, onMissing: "omit" };
      }
      const bodySchema = ((op["requestBody"] as JsonObject | undefined)?.["content"] as JsonObject | undefined)?.["application/json"] as JsonObject | undefined;
      let body: JsonValue | undefined;
      if (bodySchema?.["schema"]) {
        const s = deref(bodySchema["schema"] as JsonObject, components, notes, `${id}.body`);
        const props = (s["properties"] as JsonObject | undefined) ?? {};
        const fields: JsonObject = {};
        for (const [k, v] of Object.entries(props)) {
          properties[k] = v;
          fields[k] = { ref: `inputs.${k}` };
          if (Array.isArray(s["required"]) && (s["required"] as string[]).includes(k)) required.push(k);
        }
        body = { fields };
      }
      const responses = (op["responses"] as JsonObject | undefined) ?? {};
      const okResponse = (responses["200"] ?? responses["201"] ?? responses["default"]) as JsonObject | undefined;
      const outSchemaRaw = ((okResponse?.["content"] as JsonObject | undefined)?.["application/json"] as JsonObject | undefined)?.["schema"] as JsonObject | undefined;
      let outputs: JsonObject = { type: "object", additionalProperties: false, properties: {} };
      if (outSchemaRaw) {
        const s = deref(outSchemaRaw, components, notes, `${id}.outputs`);
        if (s["type"] === "object") outputs = closeObject(s);
        else notes.push(`${id}: response schema is not an object; declare outputs by hand`);
      } else notes.push(`${id}: no JSON response schema; outputs left empty for review`);
      const effect = method === "get" ? "read" : method === "delete" ? "destructive" : "write";
      const operation: JsonObject = { method: method.toUpperCase(), path_template: path, response: "json" };
      if (Object.keys(pathParams).length) operation["path_params"] = pathParams;
      if (Object.keys(query).length) operation["query"] = query;
      if (body !== undefined) operation["body"] = body;
      const candidate: JsonObject = {
        version: "1.0.0",
        description: String(op["summary"] ?? op["description"] ?? `${method.toUpperCase()} ${path}`).slice(0, 500),
        adapter: "http",
        connection,
        operation,
        inputs: closeObject({ type: "object", properties, required }),
        outputs,
        policy: { effect, action: id },
        review: { source: { openapi: file, operationId: op["operationId"] ?? null, schemaDigest: digestJson(op) }, resource: "REQUIRED: map to a business resource {type, id: {ref: inputs.<field>}}", effect: `derived from HTTP method ${method.toUpperCase()}; confirm`, credentialScope: `connection ${connection}` },
      };
      const firstPath = Object.keys(pathParams)[0];
      if (firstPath) candidate["resource"] = { type: "REVIEW", id: { ref: `inputs.${firstPath}` } };
      candidates[id] = candidate;
    }
  }
  const out = resolve(process.cwd(), flagString(args.flags, "out") ?? "candidates.yaml");
  writeFileSync(out, `# Non-executable tool candidates imported from ${file}. Review each entry (resource, outputs, effect,\n# credential scope), remove the review block, then add it with: sfield tools add --manifest <entry>\n${stringifyYaml({ candidates })}`);
  println(`wrote ${out} (${Object.keys(candidates).length} candidates)`);
  for (const n of notes) println(`  review: ${n}`);
  return 0;
}

function deref(schema: JsonObject, components: JsonObject, notes: string[], where: string, depth = 0): JsonObject {
  if (depth > 8) return { type: "string" };
  if (typeof schema["$ref"] === "string") {
    const name = schema["$ref"].split("/").pop()!;
    const target = components[name] as JsonObject | undefined;
    if (!target) {
      notes.push(`${where}: unresolved $ref ${schema["$ref"]}`);
      return { type: "string" };
    }
    return deref(target, components, notes, where, depth + 1);
  }
  const out: JsonObject = { ...schema };
  for (const k of ["allOf", "oneOf", "anyOf", "discriminator", "example", "examples", "nullable", "readOnly", "writeOnly", "xml", "externalDocs"]) {
    if (out[k] !== undefined) {
      if (k === "nullable" && out[k] === true && typeof out["type"] === "string") out["type"] = [out["type"] as string, "null"];
      else if (k !== "nullable") notes.push(`${where}: dropped unsupported keyword ${k}`);
      delete out[k];
    }
  }
  if (out["type"] === "object") {
    const props = (out["properties"] as JsonObject | undefined) ?? {};
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(props)) next[k] = deref(v as JsonObject, components, notes, `${where}.${k}`, depth + 1);
    out["properties"] = next;
    out["additionalProperties"] = false;
  }
  if (out["type"] === "array" && out["items"]) out["items"] = deref(out["items"] as JsonObject, components, notes, `${where}[]`, depth + 1);
  if (out["type"] === undefined && out["enum"] === undefined) out["type"] = "string";
  return out;
}

function closeObject(s: JsonObject): JsonObject {
  const out: JsonObject = { type: "object", additionalProperties: false, properties: (s["properties"] as JsonObject | undefined) ?? {} };
  if (Array.isArray(s["required"]) && (s["required"] as string[]).length) out["required"] = s["required"] as string[];
  return out;
}
