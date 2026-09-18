import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SField } from "@sfield/core";
import { httpPlugin } from "@sfield/http";
import * as presetMemory from "@sfield/preset-memory";
import { parseArgs } from "./args.js";
import { businessStarter, localStarter } from "./templates.js";

function writeProject(files: Array<{ path: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "sfield-cli-"));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  return dir;
}

const presetLoader = async () => presetMemory as unknown as import("@sfield/core").PresetModule;

test("argument parser handles flags, values, negation, and positionals", () => {
  const a = parseArgs(["run", "--agent", "support", "--message=hi there", "--json", "--no-color", "inspect", "--x", "1", "--x", "2"]);
  assert.deepEqual(a.positionals, ["run", "inspect"]);
  assert.equal(a.flags["agent"], "support");
  assert.equal(a.flags["message"], "hi there");
  assert.equal(a.flags["json"], true);
  assert.equal(a.flags["color"], false);
  assert.deepEqual(a.flags["x"], ["1", "2"]);
});

test("the generated local starter validates with no placeholders", async () => {
  const dir = writeProject(localStarter("support-agent"));
  for (const f of ["sfield.yaml", "instructions.md", "tools.ts", "app.ts", "knowledge/refund-policy.md", ".env.example", "package.json"]) assert.ok(existsSync(join(dir, f)), f);
  const report = await SField.validate({ config: join(dir, "sfield.yaml"), preset: "local", presetLoader, env: { ANTHROPIC_API_KEY: "k", SFIELD_MODEL: "claude-sonnet-5" }, tools: [] , plugins: [httpPlugin()] } as Parameters<typeof SField.validate>[0]);
  // tools.ts is TypeScript; validation here registers no code tools, so the agent's tool reference is the one expected error.
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0]!.code, "UNKNOWN_TOOL");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["start"]!, /experimental-strip-types app\.ts/);
});

test("the business-agent starter validates: HTTP tools, connection, deduplication, prerequisite, reconciliation", async () => {
  const dir = writeProject(businessStarter("biz"));
  const { defineTool } = await import("@sfield/core");
  const ordersGet = defineTool({ id: "orders.get", version: "1.0.0", description: "Get an order by its ID.", inputs: { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } }, outputs: { type: "object", additionalProperties: false, properties: {} }, authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } }, handler: async () => ({}) });
  const report = await SField.validate({
    config: join(dir, "sfield.yaml"),
    preset: "local",
    presetLoader,
    env: { ANTHROPIC_API_KEY: "k", SFIELD_MODEL: "m", BILLING_BASE_URL: "http://127.0.0.1:8787", BILLING_TOKEN: "t" },
    tools: [ordersGet],
    plugins: [httpPlugin()],
    prerequisites: { refundEligibility: async () => ({ ok: true, evidenceId: "e", expiresAt: new Date().toISOString() }) },
    reconciliation: { refund_status_by_key: async () => ({ effect: "unknown" }) },
  } as Parameters<typeof SField.validate>[0]);
  assert.deepEqual(report.errors, []);
  assert.ok(report.ok);
  assert.deepEqual(Object.keys(report.effective!.tools).sort(), ["crm.get_customer", "refunds.request"]);
  assert.equal(report.effective!.tools["refunds.request"]!.policy.requires_approval, true);
  assert.deepEqual(report.effective!.connections["billing"]!.allowed_hosts, ["127.0.0.1"]);
});
