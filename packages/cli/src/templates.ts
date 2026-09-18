/** Generated projects (§4.6 local starter, §24 business-agent L2 starter). No placeholders: every referenced object works. */

export interface ProjectFile {
  path: string;
  content: string;
}

const SFIELD_YAML = `# support-agent/sfield.yaml — complete
version: 1

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

const INSTRUCTIONS_MD = `You are the support assistant for an online store.

Help with order questions and store policies. Use the orders tool to look up current order
information instead of guessing; order IDs look like A-1001. When a policy document supports
your answer, cite it by its id, for example [source_1]. If information is missing, say what is
missing and how the customer can provide it. Never invent order details.
`;

const TOOLS_TS = `// support-agent/tools.ts — complete
import { defineTool } from "@sfield/core";

const orders = new Map([["A-1001", { id: "A-1001", status: "shipped", total_minor: 4599, currency: "INR" }]]);

export const tools = [
  defineTool({
    id: "orders.get", version: "1.0.0",
    description: "Get an order by its ID.",
    inputs:  { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } },
    outputs: { type: "object", additionalProperties: false, required: ["id", "status", "total_minor", "currency"],
               properties: { id: { type: "string" }, status: { type: "string" }, total_minor: { type: "integer" }, currency: { type: "string" } } },
    authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } },
    async handler({ order_id }) {
      const order = orders.get(String(order_id));
      if (!order) throw new Error("NOT_FOUND");
      return order;
    },
  }),
];
`;

const APP_TS = `// support-agent/app.ts — the minimal application (§4.3)
import { SField } from "@sfield/core";
import { tools } from "./tools.ts";

const sf = await SField.create({ preset: "local", config: "./sfield.yaml", tools });

const session = await sf.sessions.open({ agent: "support" });
const run = await session.send({ message: { text: process.argv[2] ?? "What is the refund policy?" } });
for await (const ev of run.events()) {
  if (ev.type === "text_delta") process.stdout.write(String(ev.payload.text));
}
const result = await run.result();
console.log("\\n" + JSON.stringify({ state: result.state, output: result.output, usage: result.usage }, null, 2));
await sf.close();
`;

const REFUND_POLICY_MD = `# Refund policy

Customers may request a refund within 30 days of delivery for items that are unused and in
their original packaging. Refunds are issued to the original payment method within 5 business
days of approval.

# Exchanges

Exchanges are available within 60 days of delivery for a different size or colour of the same
item, subject to availability.

# Shipping

Standard shipping takes 3–5 business days. Orders that show the status "shipped" have left the
warehouse and carry a tracking number in the order confirmation email.
`;

const ENV_EXAMPLE = `# One model credential is all the first run needs.
ANTHROPIC_API_KEY=
SFIELD_MODEL=claude-sonnet-5

# To use an OpenAI-compatible runtime instead (for example Ollama), change models.default in
# sfield.yaml to: provider: openai_compatible, base_url: http://localhost:11434/v1,
# credential: {env: OPENAI_API_KEY}, and set:
# OPENAI_API_KEY=ollama
`;

const GITIGNORE = `node_modules/
.sfield/
.env
`;

function packageJson(name: string, extra: Record<string, string> = {}): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      engines: { node: ">=22.13" },
      scripts: {
        start: "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning --experimental-strip-types app.ts",
        validate: "sfield validate",
        doctor: "sfield doctor",
        ...extra,
      },
      dependencies: { "@sfield/core": "^0.1.0", "@sfield/preset-local": "^0.1.0", "@sfield/cli": "^0.1.0" },
    },
    null,
    2,
  )}\n`;
}

export function localStarter(name: string): ProjectFile[] {
  return [
    { path: "sfield.yaml", content: SFIELD_YAML.replace("support-agent/", `${name}/`) },
    { path: "instructions.md", content: INSTRUCTIONS_MD },
    { path: "tools.ts", content: TOOLS_TS.replace("support-agent/", `${name}/`) },
    { path: "app.ts", content: APP_TS.replace("support-agent/", `${name}/`) },
    { path: "knowledge/refund-policy.md", content: REFUND_POLICY_MD },
    { path: ".env.example", content: ENV_EXAMPLE },
    { path: ".gitignore", content: GITIGNORE },
    { path: "package.json", content: packageJson(name) },
  ];
}

const BUSINESS_YAML = `# business-agent/sfield.yaml — L2 starter (§24): one real HTTP integration plus a function tool
version: 1

models:
  default:
    provider: anthropic
    model: "\${env:SFIELD_MODEL}"
    credential: {env: ANTHROPIC_API_KEY}

connections:
  billing:
    base_url: "\${env:BILLING_BASE_URL}"
    auth: {type: bearer, credential: {env: BILLING_TOKEN}}
    classification: confidential
    timeout_ms: 10000

sources:
  policies:
    type: local_files
    path: ./knowledge

tools:
  crm.get_customer:
    version: 1.0.0
    description: Fetch the current customer record by customer ID.
    adapter: http
    connection: billing
    operation:
      method: GET
      path_template: /customers/{customer_id}
      path_params:
        customer_id: {ref: inputs.customer_id}
      response: json
    inputs:
      type: object
      additionalProperties: false
      required: [customer_id]
      properties:
        customer_id: {type: string, pattern: '^[A-Za-z0-9_-]{1,64}$'}
    outputs:
      select: [id, tier, updated_at]
      type: object
      additionalProperties: false
      required: [id, tier, updated_at]
      properties:
        id: {type: string}
        tier: {type: string}
        updated_at: {type: string, format: date-time}
    resource:
      type: customer
      id: {ref: inputs.customer_id}
    policy:
      effect: read
      action: customer.read
      classification: confidential
  refunds.request:
    version: 1.0.0
    description: Request an approved refund for an eligible order.
    adapter: http
    connection: billing
    operation:
      method: POST
      path_template: /refunds
      body:
        fields:
          order_id: {ref: inputs.order_id}
          amount_minor: {ref: inputs.amount_minor}
          currency: {ref: inputs.currency}
      response: json
    inputs:
      type: object
      additionalProperties: false
      required: [order_id, amount_minor, currency]
      properties:
        order_id: {type: string, minLength: 1, maxLength: 64}
        amount_minor: {type: integer, minimum: 1, maximum: 1000000}
        currency: {type: string, enum: [INR, USD]}
    outputs:
      type: object
      additionalProperties: false
      required: [refund_id, status]
      properties:
        refund_id: {type: string}
        status: {type: string, enum: [pending, completed, rejected]}
    resource:
      type: order
      id: {ref: inputs.order_id}
    policy:
      effect: destructive
      action: refund.request
      classification: confidential
      requires_approval: true
      prerequisite: refundEligibility
      retry_safety: deduplicated
      max_attempts: 2
    deduplication:
      key_location: {header: Idempotency-Key}
      scope: billing_account
      retention_seconds: 604800
      payload_mismatch: reject
      reconcile_binding: refund_status_by_key

agents:
  support:
    instructions_file: ./instructions.md
    tools: [orders.get, crm.get_customer, refunds.request]
    memory:
      conversation: true
      preferences: explicit
    context:
      sources:
        - {source: policies, query: {ref: message.text}, max_items: 3, required: true}
    policy:
      preset: supervised
`;

const BUSINESS_HARNESS_TS = `// business-agent/harness.ts — host wiring (§4.7): prerequisites and reconciliation are host code
import type { SFieldOptions } from "@sfield/core";
import { httpPlugin } from "@sfield/http";
import { tools } from "./tools.ts";

const base = () => process.env.BILLING_BASE_URL ?? "http://127.0.0.1:8787";
const headers = () => ({ authorization: \`Bearer \${process.env.BILLING_TOKEN ?? ""}\` });

export async function createOptions(): Promise<SFieldOptions> {
  return {
    preset: "local",
    config: "./sfield.yaml",
    tools,
    plugins: [httpPlugin()],
    // Evidence for refunds.request: current eligibility for the same order and amount (§9.5).
    prerequisites: {
      refundEligibility: async (req) => {
        const res = await fetch(\`\${base()}/orders/\${encodeURIComponent(String(req.inputs.order_id))}/eligibility?amount_minor=\${Number(req.inputs.amount_minor)}\`, { headers: headers() });
        if (!res.ok) return { ok: false, code: "ELIGIBILITY_UNAVAILABLE", reason: \`HTTP \${res.status}\` };
        const body = (await res.json()) as { eligible: boolean; reason?: string; version: string };
        return body.eligible
          ? { ok: true, evidenceId: \`elig:\${req.argumentsDigest}\`, expiresAt: new Date(Date.now() + 300_000).toISOString(), sourceVersion: body.version }
          : { ok: false, code: "NOT_ELIGIBLE", reason: body.reason ?? "not eligible" };
      },
    },
    // Recovery after a crash between dispatch and result (§16.4): ask the backend by idempotency key.
    reconciliation: {
      refund_status_by_key: async ({ intent }) => {
        const key = String(intent.idempotencyKey ?? "");
        if (!key) return { effect: "unknown" };
        const res = await fetch(\`\${base()}/refunds/by-key/\${encodeURIComponent(key)}\`, { headers: headers() });
        if (res.status === 404) return { effect: "none" };
        if (!res.ok) return { effect: "unknown" };
        return { effect: "confirmed", output: await res.json() };
      },
    },
  };
}
`;

const BUSINESS_APP_TS = `// business-agent/app.ts
import { SField } from "@sfield/core";
import { createOptions } from "./harness.ts";

const sf = await SField.create(await createOptions());
const session = await sf.sessions.open({ agent: "support" });
const run = await session.send({ message: { text: process.argv[2] ?? "Customer C-1 wants a refund of 4599 INR for order A-1001. Check eligibility and request it." } });
for await (const ev of run.events()) {
  if (ev.type === "text_delta") process.stdout.write(String(ev.payload.text));
  else if (ev.type === "approval_requested") process.stderr.write("\\n[approval requested]\\n");
}
const result = await run.result();
console.log("\\n" + JSON.stringify({ state: result.state, output: result.output, effects: result.effects, usage: result.usage }, null, 2));
await sf.close();
`;

const MOCK_BACKEND_TS = `// business-agent/mock-backend.ts — a local stand-in for the billing API so the starter runs end to end.
// Replace BILLING_BASE_URL and BILLING_TOKEN in .env to point at the real system; the tools do not change.
import { createServer } from "node:http";

const customers = new Map([["C-1", { id: "C-1", tier: "gold", updated_at: new Date().toISOString(), internal_notes: "not exposed" }]]);
const orders = new Map([["A-1001", { id: "A-1001", customer: "C-1", total_minor: 4599, currency: "INR", delivered_days_ago: 3 }]]);
const refundsByKey = new Map<string, { refund_id: string; status: string; payload: string }>();
let seq = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (token !== (process.env.BILLING_TOKEN ?? "dev-token")) return json(res, 401, { error: "unauthorized" });
  let m: RegExpMatchArray | null;
  if (req.method === "GET" && (m = url.pathname.match(/^\\/customers\\/([^/]+)$/))) {
    const c = customers.get(decodeURIComponent(m[1]!));
    return c ? json(res, 200, c) : json(res, 404, { error: "not found" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\\/orders\\/([^/]+)\\/eligibility$/))) {
    const o = orders.get(decodeURIComponent(m[1]!));
    const amount = Number(url.searchParams.get("amount_minor"));
    if (!o) return json(res, 200, { eligible: false, reason: "unknown order", version: "v1" });
    const eligible = o.delivered_days_ago <= 30 && amount <= o.total_minor;
    return json(res, 200, { eligible, reason: eligible ? undefined : "outside policy", version: "v1" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\\/refunds\\/by-key\\/([^/]+)$/))) {
    const r = refundsByKey.get(decodeURIComponent(m[1]!));
    return r ? json(res, 200, { refund_id: r.refund_id, status: r.status }) : json(res, 404, { error: "not found" });
  }
  if (req.method === "POST" && url.pathname === "/refunds") {
    const body = await read(req);
    const key = String(req.headers["idempotency-key"] ?? "");
    if (key && refundsByKey.has(key)) {
      const prior = refundsByKey.get(key)!;
      if (prior.payload !== body) return json(res, 409, { error: "payload mismatch for idempotency key" });
      return json(res, 200, { refund_id: prior.refund_id, status: prior.status });
    }
    const refund = { refund_id: \`rf_\${++seq}\`, status: "pending", payload: body };
    if (key) refundsByKey.set(key, refund);
    return json(res, 201, { refund_id: refund.refund_id, status: refund.status });
  }
  json(res, 404, { error: "no route" });
});

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function read(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s)); });
}

const port = Number(process.env.MOCK_PORT ?? 8787);
server.listen(port, "127.0.0.1", () => console.log(\`mock billing backend on http://127.0.0.1:\${port}\`));
`;

const BUSINESS_ENV = `ANTHROPIC_API_KEY=
SFIELD_MODEL=claude-sonnet-5

# The generated mock backend (npm run backend) accepts this token. Point these at your real billing
# system when you are ready; the tools and agent do not change.
BILLING_BASE_URL=http://127.0.0.1:8787
BILLING_TOKEN=dev-token
`;

export function businessStarter(name: string): ProjectFile[] {
  return [
    { path: "sfield.yaml", content: BUSINESS_YAML.replace("business-agent/", `${name}/`) },
    { path: "instructions.md", content: INSTRUCTIONS_MD + "\nFor refunds: first fetch the customer and the order, then request the refund with the exact amount in minor units and the order currency. Report the refund id and status exactly as returned.\n" },
    { path: "tools.ts", content: TOOLS_TS.replace("support-agent/", `${name}/`) },
    { path: "harness.ts", content: BUSINESS_HARNESS_TS.replace("business-agent/", `${name}/`) },
    { path: "app.ts", content: BUSINESS_APP_TS.replace("business-agent/", `${name}/`) },
    { path: "mock-backend.ts", content: MOCK_BACKEND_TS.replace("business-agent/", `${name}/`) },
    { path: "knowledge/refund-policy.md", content: REFUND_POLICY_MD },
    { path: ".env.example", content: BUSINESS_ENV },
    { path: ".gitignore", content: GITIGNORE },
    {
      path: "package.json",
      content: packageJson(name, { backend: "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning --experimental-strip-types mock-backend.ts" }).replace('"@sfield/cli": "^0.1.0"', '"@sfield/cli": "^0.1.0",\n    "@sfield/http": "^0.1.0"'),
    },
  ];
}
