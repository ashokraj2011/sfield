import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, loadConfigDocument } from "../config/load.js";
import { compileConfig, type CompileContext } from "../config/compile.js";
import { ConfigErrors, SFieldError } from "../errors.js";
import { defineTool } from "../registry/define-tool.js";
import { FunctionAdapter } from "../registry/function-adapter.js";
import type { JsonObject } from "../types/common.js";
import type { ToolAdapter } from "../types/tool.js";
import { explainConfig } from "../config/explain.js";

const httpAdapter: ToolAdapter = {
  id: "http",
  operationSchema: { type: "object", additionalProperties: false, required: ["method", "path_template"], properties: { method: { type: "string" }, path_template: { type: "string" }, path_params: { type: "object" }, query: { type: "object" }, body: { type: "object" }, response: { type: "string" } } },
  async prepare() {
    throw new Error("unused");
  },
  async execute() {
    throw new Error("unused");
  },
};

function ctx(overrides: Partial<CompileContext> = {}): CompileContext {
  const adapters = new Map<string, ToolAdapter>([["function", new FunctionAdapter()], ["http", httpAdapter]]);
  return {
    registrations: { codeTools: [], adapters, providers: new Set(["anthropic", "openai_compatible"]), retrievalTypes: new Map([["local_files", { type: "local_files", configSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, include: { type: "array" } }, additionalProperties: false }, create: () => { throw new Error("unused"); } }]]), verifiers: new Set(), prerequisites: new Set(["refundEligibility"]), contextTransforms: new Set(), plugins: [], reconciliation: new Set(["refund_status_by_key"]) },
    bindings: { models: {}, connections: {}, retrieval: {} },
    limits: {},
    env: { ANTHROPIC_API_KEY: "k", SFIELD_MODEL: "claude-x", CRM_TOKEN: "t" },
    ...overrides,
  };
}

const starterYaml = `version: 1

models:
  default:
    provider: anthropic
    model: "\${env:SFIELD_MODEL}"
    credential: {env: ANTHROPIC_API_KEY}

sources:
  policies:
    type: local_files
    path: ./knowledge

agents:
  support:
    instructions_file: ./instructions.md
    tools: [orders.get]
    memory:
      conversation: true
      preferences: explicit
    context:
      sources:
        - {source: policies, query: {ref: message.text}, max_items: 3}
`;

function ordersGet() {
  return defineTool({ id: "orders.get", version: "1.0.0", description: "Get an order", inputs: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } }, outputs: { type: "object", additionalProperties: false, properties: {} }, authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } }, handler: async () => ({}) });
}

test("the generated starter configuration compiles with defaults, env substitution, and instruction files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-cfg-"));
  writeFileSync(join(dir, "sfield.yaml"), starterYaml);
  writeFileSync(join(dir, "instructions.md"), "Help with orders.\n");
  const loaded = loadConfigFile(join(dir, "sfield.yaml"));
  const cfg = compileConfig(loaded, ctx({ registrations: { ...ctx().registrations, codeTools: [ordersGet()] } }));
  assert.equal(cfg.models["default"]!.model, "claude-x");
  assert.equal(cfg.provenance["models.default.model"], "env:SFIELD_MODEL");
  const agent = cfg.agents["support"]!;
  assert.equal(agent.instructions, "Help with orders.\n");
  assert.equal(agent.instructions_source, "instructions.md");
  assert.deepEqual(agent.tools, ["orders.get@1.0.0"]);
  assert.equal(agent.budget.max_turns, 20);
  assert.equal(agent.context.sources[0]!.max_tokens, 2000);
  assert.equal(agent.context.sources[0]!.max_items, 3);
  assert.equal(agent.policy.preset, "supervised");
  assert.equal(agent.runtime.loop_detection.identical_call_window, 3);
  assert.equal(cfg.provenance["agents.support.budget.max_turns"], "default");
  assert.ok(cfg.digest.startsWith("sha256:"));
  assert.ok(cfg.lock.tools["orders.get@1.0.0"]);
  // Digest is stable across compilations and excludes credentials.
  const again = compileConfig(loaded, ctx({ registrations: { ...ctx().registrations, codeTools: [ordersGet()] } }));
  assert.equal(again.digest, cfg.digest);
  const explained = explainConfig(cfg, "support");
  assert.ok(explained.fields.some((f) => f.path === "agents.support.budget.max_turns" && f.source === "default"));
});

test("configuration errors carry path, code, and suggestion", () => {
  const cases: Array<{ doc: JsonObject; code: string; path: string }> = [
    { doc: { version: 1, deployment: "service" }, code: "UNKNOWN_KEY", path: "deployment" },
    { doc: { version: 1, models: { default: { binding: "x" } }, agents: { a: { instructions: "hi" } } }, code: "UNKNOWN_BINDING", path: "models.default.binding" },
    { doc: { version: 1, agents: { a: { instructions: "hi" } } }, code: "UNKNOWN_MODEL", path: "agents.a.model" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "NOPE" } } }, agents: { a: { instructions: "hi" } } }, code: "MISSING_CREDENTIAL", path: "models.default.credential" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" } } }, agents: { a: { instructions: "hi ${env:X}" } } }, code: "INVALID_CONFIG", path: "agents.a.instructions" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" } } }, agents: { a: { instructions: "hi", tools: ["missing.tool"] } } }, code: "UNKNOWN_TOOL", path: "agents.a.tools[0]" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" } } }, agents: { a: { instructions: "hi", tools: ["ask_user"] } } }, code: "INVALID_CONFIG", path: "agents.a.tools[0]" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" } } }, agents: { a: { instructions: "hi", runtime: { loop_detection: { enabled: false } } } } }, code: "INVALID_CONFIG", path: "agents.a.runtime.loop_detection.enabled" },
    { doc: { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" }, params: { logprobs: true } } } }, code: "INVALID_CONFIG", path: "models.default.params.logprobs" },
    { doc: { version: 1, extensions: { unknown_plugin: {} } }, code: "UNKNOWN_PLUGIN", path: "extensions.unknown_plugin" },
  ];
  for (const c of cases) {
    try {
      compileConfig(loadConfigDocument(c.doc, "/tmp"), ctx());
      assert.fail(`expected ${c.code} for ${JSON.stringify(c.doc)}`);
    } catch (e) {
      const err = e instanceof ConfigErrors ? e.errors[0]! : (e as SFieldError);
      assert.equal(err.code, c.code, `${JSON.stringify(c.doc)} -> ${err.message}`);
      assert.equal(err.path, c.path, err.message);
    }
  }
});

test("configured HTTP tool: outputs.select, deduplication, prerequisites, and the digest are compiled", () => {
  const doc: JsonObject = {
    version: 1,
    connections: { billing: { base_url: "https://billing.example.com/v1", auth: { type: "bearer", credential: { env: "CRM_TOKEN" } }, classification: "confidential" } },
    tools: {
      "refunds.request": {
        version: "1.0.0",
        description: "Request a refund",
        adapter: "http",
        connection: "billing",
        operation: { method: "POST", path_template: "/refunds", body: { fields: { order_id: { ref: "inputs.order_id" } } }, response: "json" },
        inputs: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } },
        outputs: { select: ["refund_id", "status"], type: "object", additionalProperties: false, required: ["refund_id", "status"], properties: { refund_id: { type: "string" }, status: { type: "string" } } },
        resource: { type: "order", id: { ref: "inputs.order_id" } },
        policy: { effect: "destructive", action: "refund.request", requires_approval: true, prerequisite: "refundEligibility", retry_safety: "deduplicated", max_attempts: 2 },
        deduplication: { key_location: { header: "Idempotency-Key" }, scope: "billing_account", retention_seconds: 604800, payload_mismatch: "reject", reconcile_binding: "refund_status_by_key" },
      },
      "crm.get_customer": {
        version: "1.0.0",
        description: "Fetch a customer",
        adapter: "http",
        connection: "billing",
        operation: { method: "GET", path_template: "/customers/{id}", path_params: { id: { ref: "inputs.id" } }, response: "json" },
        inputs: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
        outputs: { type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
        policy: { effect: "read" },
      },
    },
  };
  const cfg = compileConfig(loadConfigDocument(doc, "/tmp"), ctx());
  const t = cfg.tools["refunds.request"]!;
  assert.deepEqual(t.select, ["refund_id", "status"]);
  assert.equal(t.policy.max_attempts, 2);
  assert.equal(t.deduplication?.reconcileBinding, "refund_status_by_key");
  assert.ok(t.digest.startsWith("sha256:"));
  assert.deepEqual(cfg.connections["billing"]!.allowed_hosts, ["billing.example.com"]);
  const read = cfg.tools["crm.get_customer"]!;
  assert.equal(read.policy.action, "crm.get_customer");
  assert.deepEqual(read.resource, { type: "tool", id: { literal: "crm.get_customer" } });
  assert.ok(cfg.notes.some((n) => n.code === "DEFAULT_RESOURCE"));
  // A mutation without a resource is an error; an operation referencing a foreign root is an error.
  const badDoc = JSON.parse(JSON.stringify(doc)) as JsonObject;
  delete ((badDoc["tools"] as JsonObject)["refunds.request"] as JsonObject)["resource"];
  assert.throws(() => compileConfig(loadConfigDocument(badDoc, "/tmp"), ctx()), (e: unknown) => e instanceof ConfigErrors && e.errors[0]!.code === "INVALID_CONFIG" && e.errors[0]!.path === "tools.refunds.request.resource");
});

test("includes combine dictionaries, reject duplicates and cycles", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-inc-"));
  writeFileSync(join(dir, "root.yaml"), "version: 1\nincludes: [./a.yaml]\nmodels:\n  default: {provider: anthropic, model: m, credential: {env: ANTHROPIC_API_KEY}}\n");
  writeFileSync(join(dir, "a.yaml"), "version: 1\nagents:\n  a: {instructions: hi}\n");
  const cfg = compileConfig(loadConfigFile(join(dir, "root.yaml")), ctx());
  assert.ok(cfg.agents["a"]);
  assert.equal(cfg.provenance["agents.a.instructions"], "a.yaml");
  writeFileSync(join(dir, "dup.yaml"), "version: 1\nincludes: [./a.yaml, ./a2.yaml]\nmodels:\n  default: {provider: anthropic, model: m, credential: {env: ANTHROPIC_API_KEY}}\n");
  writeFileSync(join(dir, "a2.yaml"), "version: 1\nagents:\n  a: {instructions: other}\n");
  assert.throws(() => loadConfigFile(join(dir, "dup.yaml")), (e: unknown) => SFieldError.is(e, "DUPLICATE_DEFINITION"));
  writeFileSync(join(dir, "c1.yaml"), "version: 1\nincludes: [./c2.yaml]\n");
  writeFileSync(join(dir, "c2.yaml"), "version: 1\nincludes: [./c1.yaml]\n");
  assert.throws(() => loadConfigFile(join(dir, "c1.yaml")), (e: unknown) => SFieldError.is(e, "INCLUDE_CYCLE"));
});

test("overrides merge dictionaries, replace arrays, keep null, and remove with $remove", () => {
  const doc: JsonObject = { version: 1, models: { default: { provider: "anthropic", model: "m", credential: { env: "ANTHROPIC_API_KEY" } } }, agents: { a: { instructions: "hi", tools: [], budget: { max_turns: 5, max_tokens: 100 } } } };
  const cfg = compileConfig(loadConfigDocument(doc, "/tmp"), ctx({ overrides: [{ agents: { a: { budget: { max_turns: 9, max_tokens: { $remove: true } } } } }] }));
  assert.equal(cfg.agents["a"]!.budget.max_turns, 9);
  assert.equal(cfg.agents["a"]!.budget.max_tokens, 200000);
  assert.equal(cfg.provenance["agents.a.budget.max_turns"], "override[0]");
  assert.equal(cfg.provenance["agents.a.budget.max_tokens"], "default");
});
