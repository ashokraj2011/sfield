import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AdapterExecutionContext,
  ConnectionHandle,
  DataClassification,
  DeduplicationContract,
  Effect,
  JsonObject,
  JsonValue,
  PreparationContext,
  Principal,
  ToolAdapter,
  ToolDefinition,
  ToolResource,
  ValueBinding,
} from "@sfield/core";
import { InMemoryArtifactStore, OMIT, SFieldError, digestJson, normalizeTool, resolveBinding, sharedValidator } from "@sfield/core";
import { HTTP_OPERATION_SCHEMA, HttpAdapter, httpAdapter, httpPlugin } from "./index.js";

// ---------------------------------------------------------------------------------------------------------------
// A real local HTTP server; every request it sees is recorded for assertions.

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

class TestServer {
  readonly requests: SeenRequest[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private constructor(
    readonly server: Server,
    readonly port: number,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static async start(): Promise<TestServer> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const ts = new TestServer(server, (server.address() as AddressInfo).port);
    server.on("request", (req, res) => ts.handle(req, res));
    return ts;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const seen: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      this.requests.push(seen);
      this.route(seen, req, res);
    });
  }

  private route(seen: SeenRequest, req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(seen.url, "http://localhost");
    const path = url.pathname;
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/customers/")) {
      return json(200, { id: decodeURIComponent(path.slice("/customers/".length)), query: Object.fromEntries(url.searchParams), tier: "gold" });
    }
    if (path === "/echo") {
      let parsed: unknown = null;
      try {
        parsed = seen.body ? JSON.parse(seen.body) : null;
      } catch {
        parsed = seen.body;
      }
      return json(200, { method: seen.method, url: seen.url, headers: seen.headers, body: parsed });
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: "/echo" });
      return void res.end("moved");
    }
    if (path === "/big") {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      for (let i = 0; i < 20; i++) res.write(chunk);
      return void res.end();
    }
    if (path === "/slow") {
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (!res.destroyed && !res.writableEnded) json(200, { late: true });
      }, 2000);
      this.timers.add(t);
      return;
    }
    if (path === "/hangup") {
      req.socket.destroy();
      return;
    }
    if (path.startsWith("/status/")) {
      const status = Number(path.slice("/status/".length));
      res.writeHead(status, { "content-type": "text/plain" });
      return void res.end(`status ${status}; authorization=${seen.headers["authorization"] ?? "none"}; x-api-key=${seen.headers["x-api-key"] ?? "none"}`);
    }
    if (path === "/invalid-json") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end("not json {");
    }
    if (path === "/text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("hello, world");
    }
    if (path === "/artifact") {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(Buffer.from(PNG_BYTES));
    }
    if (path === "/empty") {
      res.writeHead(204);
      return void res.end();
    }
    return json(404, { error: "no such route" });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures mirroring what the core pipeline hands an adapter.

const PRINCIPAL: Principal = { tenantId: "t1", subjectId: "u1", roles: ["user"], attributes: {} };
const INPUTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    limit: { type: "integer" },
    cursor: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    order_id: { type: "string" },
    amount_minor: { type: "integer" },
    currency: { type: "string" },
    note: { type: "string" },
    payload: { type: "object", additionalProperties: false, properties: { kind: { type: "string" }, n: { type: "integer" } } },
  },
};
const OUTPUTS_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

interface ToolOptions {
  effect?: Effect;
  dedup?: DeduplicationContract;
  resource?: ToolResource;
  conflictKey?: ValueBinding;
  timeoutMs?: number;
}

function tool(operation: JsonObject, opts: ToolOptions = {}): ToolDefinition {
  return normalizeTool(
    {
      id: "test.tool",
      version: "1.0.0",
      description: "adapter test tool",
      adapter: "http",
      connection: "api",
      operation,
      inputs: INPUTS_SCHEMA,
      outputs: OUTPUTS_SCHEMA,
      resource: opts.resource ?? { type: "thing", id: { literal: "r1" } },
      policy: {
        effect: opts.effect ?? "read",
        retrySafety: opts.dedup ? "deduplicated" : "never",
        timeoutMs: opts.timeoutMs,
        conflictKey: opts.conflictKey,
      },
      deduplication: opts.dedup,
    },
    { source: "config" },
  );
}

interface ConnectionOptions {
  auth?: { type: "bearer" | "header" | "basic"; name?: string; value: string };
  allowedHosts?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  classification?: DataClassification;
}

function connection(baseUrl: string, opts: ConnectionOptions = {}): ConnectionHandle {
  const config: JsonObject = {
    base_url: baseUrl,
    allowed_hosts: opts.allowedHosts ?? ["127.0.0.1"],
    timeout_ms: opts.timeoutMs ?? 10000,
    classification: opts.classification ?? "internal",
    headers: opts.headers ?? {},
  };
  return {
    identity: { id: "connection:api", revision: "rev1", accountScope: baseUrl, classification: opts.classification ?? "internal" },
    config,
    material: async (): Promise<JsonObject> => (opts.auth ? { auth: { type: opts.auth.type, name: opts.auth.name ?? null, value: opts.auth.value } } : {}),
  };
}

function prepCtx(inputs: JsonObject, conn: ConnectionHandle | undefined): PreparationContext {
  const roots = { inputs };
  return {
    principal: PRINCIPAL,
    runId: "run_1",
    callId: "call_1",
    connection: conn,
    resolve: (binding: ValueBinding, field: string): JsonValue | undefined => {
      const v = resolveBinding(binding, roots, { field, allowOmit: true, allowedRoots: ["inputs"] });
      return v === OMIT ? undefined : v;
    },
  };
}

function execCtx(conn: ConnectionHandle | undefined, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    principal: PRINCIPAL,
    signal: new AbortController().signal,
    attemptId: "att_1",
    callId: "call_1",
    runId: "run_1",
    maxOutputBytes: 65536,
    timeoutMs: 5000,
    connection: conn,
    artifacts: new InMemoryArtifactStore(),
    attempt: 1,
    ...overrides,
  };
}

const adapter = new HttpAdapter();
let server: TestServer;

async function call(def: ToolDefinition, inputs: JsonObject, conn: ConnectionHandle, exec: Partial<AdapterExecutionContext> = {}) {
  const prepared = await adapter.prepare(def, inputs, prepCtx(inputs, conn));
  const result = await adapter.execute(prepared, execCtx(conn, exec));
  return { prepared, result };
}

function isCode(code: string): (e: unknown) => boolean {
  return (e: unknown) => SFieldError.is(e, code);
}

before(async () => {
  server = await TestServer.start();
});

after(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------------------------------------------

test("operation schema compiles under the strict validator and accepts the spec examples", () => {
  const v = sharedValidator();
  const ok = (op: JsonObject) => assert.deepEqual(v.validate(HTTP_OPERATION_SCHEMA, op), { ok: true, errors: [] }, JSON.stringify(op));
  const bad = (op: JsonObject) => assert.equal(v.validate(HTTP_OPERATION_SCHEMA, op).ok, false, JSON.stringify(op));
  // §8.1 and §24 examples
  ok({ method: "GET", path_template: "/customers/{customer_id}", path_params: { customer_id: { ref: "inputs.customer_id" } }, response: "json" });
  ok({ method: "POST", path_template: "/refunds", body: { fields: { order_id: { ref: "inputs.order_id" }, amount_minor: { ref: "inputs.amount_minor" }, currency: { ref: "inputs.currency" } } }, response: "json" });
  ok({ method: "PUT", path_template: "/items/{id}", path_params: { id: { literal: 5 } }, body: { literal: { a: 1 } }, expected_status: 201 });
  ok({ method: "DELETE", path_template: "/items/{id}", path_params: { id: { ref: "inputs.id", onMissing: "error" } }, expected_status: [204, 404], query: { "filter[status]": { literal: "x" } } });
  bad({ method: "HEAD", path_template: "/x" });
  bad({ path_template: "/x" });
  bad({ method: "GET", path_template: "x" });
  bad({ method: "GET", path_template: "/x?y=1" });
  bad({ method: "GET", path_template: "/x", response: "xml" });
  bad({ method: "GET", path_template: "/x", expected_status: 700 });
  bad({ method: "GET", path_template: "/x", expected_status: [] });
  bad({ method: "POST", path_template: "/x", body: { literal: 1, ref: "inputs.a" } });
  bad({ method: "POST", path_template: "/x", body: { fields: { a: { ref: "inputs.a" } }, literal: 1 } });
  bad({ method: "POST", path_template: "/x", body: { fields: { a: { ref: "inputs.a", onMissing: "drop" } } } });
  bad({ method: "POST", path_template: "/x", body: { fields: { __proto__: { literal: 1 } } } });
  bad({ method: "GET", path_template: "/x", headers: { "x-a": "b" } });
  bad({ method: "GET", path_template: "/x", path_params: { "bad name": { literal: 1 } } });
});

test("GET: path and query params are encoded, omitted optional query is dropped, static headers ride along", async () => {
  const def = tool({
    method: "GET",
    path_template: "/customers/{customer_id}",
    path_params: { customer_id: { ref: "inputs.id" } },
    query: { limit: { ref: "inputs.limit" }, cursor: { ref: "inputs.cursor", onMissing: "omit" }, verbose: { literal: true }, tags: { ref: "inputs.tags", onMissing: "omit" } },
    response: "json",
  });
  const conn = connection(server.baseUrl, { headers: { "X-Api-Version": "2" } });
  const { prepared, result } = await call(def, { id: "c/1 x", limit: 5, tags: ["a", "b"] }, conn);
  assert.equal(prepared.adapter, "http");
  assert.equal(prepared.operation["url"], `${server.baseUrl}/customers/c%2F1%20x?limit=5&verbose=true&tags=a&tags=b`);
  assert.deepEqual(prepared.operation["headers"], { "x-api-version": "2" });
  assert.equal(prepared.operation["body"], null);
  assert.equal(prepared.operation["effect"], "read");
  assert.equal(prepared.operation["dedup"], null);
  assert.deepEqual(prepared.resource, { type: "thing", id: "r1" });
  assert.deepEqual(prepared.summary, { method: "GET", url: prepared.operation["url"], body: null });
  // JSON-serializable and digestable: it is bound into the prepared invocation (§9.4).
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.operation)), prepared.operation);
  assert.match(digestJson(prepared.operation), /^sha256:[0-9a-f]{64}$/);

  assert.equal(result.error, undefined);
  assert.equal(result.payloadValid, true);
  assert.equal(result.effect, "none");
  assert.equal(result.transport.status, 200);
  assert.ok(result.transport.bytes > 0);
  assert.deepEqual((result.payload as JsonObject)["query"], { limit: "5", verbose: "true", tags: "b" });
  assert.equal((result.payload as JsonObject)["id"], "c/1 x");
  const seen = server.requests.at(-1)!;
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/customers/c%2F1%20x?limit=5&verbose=true&tags=a&tags=b");
  assert.equal(seen.headers["x-api-version"], "2");
  assert.equal(seen.headers["authorization"], undefined);
});

test("base path of the connection is kept and joined with the template", async () => {
  const def = tool({ method: "GET", path_template: "/{id}", path_params: { id: { ref: "inputs.id" } } });
  const conn = connection(`${server.baseUrl}/customers/`);
  const { prepared, result } = await call(def, { id: "42" }, conn);
  assert.equal(prepared.operation["url"], `${server.baseUrl}/customers/42`);
  assert.equal((result.payload as JsonObject)["id"], "42");
});

test("POST: body fields drop omitted fields and are sent as JSON; a literal body is sent verbatim", async () => {
  const def = tool(
    {
      method: "POST",
      path_template: "/echo",
      body: { fields: { order_id: { ref: "inputs.order_id" }, amount_minor: { ref: "inputs.amount_minor" }, currency: { literal: "INR" }, note: { ref: "inputs.note", onMissing: "omit" } } },
    },
    { effect: "write", resource: { type: "order", id: { ref: "inputs.order_id" } } },
  );
  const conn = connection(server.baseUrl);
  const { prepared, result } = await call(def, { order_id: "o-1", amount_minor: 1250 }, conn);
  assert.deepEqual(prepared.operation["body"], { order_id: "o-1", amount_minor: 1250, currency: "INR" });
  assert.deepEqual(prepared.operation["headers"], { "content-type": "application/json" });
  assert.deepEqual(prepared.resource, { type: "order", id: "o-1" });
  assert.equal(result.effect, "confirmed");
  assert.equal(result.payloadValid, true);
  const seen = server.requests.at(-1)!;
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen.body), { order_id: "o-1", amount_minor: 1250, currency: "INR" });

  const literal = tool({ method: "PUT", path_template: "/echo", body: { literal: { kind: "ping", n: 1, nested: [1, null, "x"] } } }, { effect: "write" });
  const second = await call(literal, {}, conn);
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), { kind: "ping", n: 1, nested: [1, null, "x"] });
  assert.equal(second.result.effect, "confirmed");

  const whole = tool({ method: "PATCH", path_template: "/echo", body: { ref: "inputs.payload", onMissing: "omit" } }, { effect: "write" });
  const third = await call(whole, {}, conn);
  assert.equal(third.prepared.operation["body"], null);
  assert.equal(server.requests.at(-1)!.body, "");
  assert.equal(server.requests.at(-1)!.headers["content-type"], undefined);
  assert.equal(third.result.effect, "confirmed");

  await assert.rejects(adapter.prepare(tool({ method: "GET", path_template: "/echo", body: { literal: 1 } }), {}, prepCtx({}, conn)), isCode("INVALID_CONFIG"));
});

test("auth: bearer, header, and basic credentials reach the server and never appear in the prepared operation", async () => {
  const def = tool({ method: "GET", path_template: "/echo" });
  const cases: Array<{ auth: ConnectionOptions["auth"]; header: string; expected: string; secret: string }> = [
    { auth: { type: "bearer", value: "sk-live-bearer-secret-123456" }, header: "authorization", expected: "Bearer sk-live-bearer-secret-123456", secret: "sk-live-bearer-secret-123456" },
    { auth: { type: "header", name: "X-Api-Key", value: "apikey-secret-abcdef" }, header: "x-api-key", expected: "apikey-secret-abcdef", secret: "apikey-secret-abcdef" },
    { auth: { type: "basic", value: "user:hunter2-secret" }, header: "authorization", expected: `Basic ${Buffer.from("user:hunter2-secret").toString("base64")}`, secret: "hunter2-secret" },
  ];
  for (const c of cases) {
    const conn = connection(server.baseUrl, { auth: c.auth });
    const { prepared, result } = await call(def, {}, conn);
    assert.equal(result.payloadValid, true, c.header);
    const seen = server.requests.at(-1)!;
    assert.equal(seen.headers[c.header], c.expected);
    const serialized = JSON.stringify(prepared);
    assert.ok(!serialized.includes(c.secret), `prepared operation leaks ${c.header}`);
    assert.ok(!serialized.includes(Buffer.from(c.secret).toString("base64")));
  }
});

test("model-visible input cannot inject headers or change the origin", async () => {
  const conn = connection(server.baseUrl);
  await assert.rejects(adapter.prepare(tool({ method: "GET", path_template: "/echo", headers: { authorization: "Bearer x" } } as JsonObject), {}, prepCtx({}, conn)), isCode("INVALID_CONFIG"));
  const def = tool({ method: "GET", path_template: "/customers/{id}", path_params: { id: { ref: "inputs.id" } } });
  for (const evil of ["..", ".", "%2e%2e", "../admin", "https://evil.example", "a/b?x=1#f", ""]) {
    if (evil === "") {
      await assert.rejects(adapter.prepare(def, { id: evil }, prepCtx({ id: evil }, conn)), isCode("INVALID_INPUT"), evil);
      continue;
    }
    if (evil === ".." || evil === "." || evil === "%2e%2e") {
      await assert.rejects(adapter.prepare(def, { id: evil }, prepCtx({ id: evil }, conn)), isCode("INVALID_INPUT"), evil);
      continue;
    }
    const prepared = await adapter.prepare(def, { id: evil }, prepCtx({ id: evil }, conn));
    const url = new URL(prepared.operation["url"] as string);
    assert.equal(url.origin, new URL(server.baseUrl).origin, evil);
    assert.equal(url.pathname, `/customers/${encodeURIComponent(evil)}`, evil);
  }
  const staticHeaders = connection(server.baseUrl, { headers: { Cookie: "session=1" } });
  await assert.rejects(adapter.prepare(def, { id: "1" }, prepCtx({ id: "1" }, staticHeaders)), isCode("INVALID_CONFIG"));
  const userinfo = connection("http://user:pw@127.0.0.1:1/");
  await assert.rejects(adapter.prepare(def, { id: "1" }, prepCtx({ id: "1" }, userinfo)), isCode("INVALID_CONFIG"));
});

test("path templates: placeholders must be bound and used; origin-changing templates are refused", async () => {
  const conn = connection(server.baseUrl);
  const prepare = (op: JsonObject, inputs: JsonObject = {}) => adapter.prepare(tool(op), inputs, prepCtx(inputs, conn));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/{id}" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a", path_params: { id: { literal: 1 } } }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a//b" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/../b" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/%2e%2e/b" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/https://evil.example/x" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/{id" }), isCode("INVALID_CONFIG"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/{id}", path_params: { id: { ref: "inputs.id", onMissing: "omit" } } }), isCode("MISSING_REFERENCE"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/{id}", path_params: { id: { ref: "inputs.id" } } }), isCode("MISSING_REFERENCE"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a/{id}", path_params: { id: { ref: "inputs.payload" } } }, { payload: { kind: "k" } }), isCode("INVALID_INPUT"));
  await assert.rejects(prepare({ method: "GET", path_template: "/a", query: { q: { ref: "inputs.payload" } } }, { payload: { kind: "k" } }), isCode("INVALID_INPUT"));
  const okDef = tool({ method: "GET", path_template: "/files/{id}.json", path_params: { id: { literal: 7 } } });
  const prepared = await adapter.prepare(okDef, {}, prepCtx({}, conn));
  assert.equal(prepared.operation["url"], `${server.baseUrl}/files/7.json`);
});

test("missing connection and unresolvable resource ids are rejected at prepare", async () => {
  const def = tool({ method: "GET", path_template: "/echo" }, { resource: { type: "customer", id: { ref: "inputs.id" } } });
  await assert.rejects(adapter.prepare(def, { id: "1" }, prepCtx({ id: "1" }, undefined)), isCode("UNKNOWN_BINDING"));
  await assert.rejects(adapter.prepare(def, {}, prepCtx({}, connection(server.baseUrl))), isCode("MISSING_REFERENCE"));
  const result = await adapter.execute({ adapter: "http", operation: { method: "GET" }, resource: { type: "t", id: "1" }, summary: {} }, execCtx(undefined));
  assert.equal(result.effect, "not_started");
  assert.equal(result.error?.code, "INVALID_CONFIG");
});

test("idempotency key is inserted at the declared location: header, query, body field", async () => {
  const conn = connection(server.baseUrl);
  const contract = (keyLocation: DeduplicationContract["keyLocation"]): DeduplicationContract => ({ keyLocation, scope: "acct", retentionSeconds: 604800, payloadMismatch: "reject" });
  const header = tool({ method: "POST", path_template: "/echo", body: { fields: { order_id: { literal: "o1" } } } }, { effect: "destructive", dedup: contract({ header: "Idempotency-Key" }) });
  const h = await call(header, {}, conn, { idempotencyKey: "key-123" });
  assert.deepEqual(h.prepared.operation["dedup"], { key_location: { header: "Idempotency-Key" } });
  assert.ok(!JSON.stringify(h.prepared).includes("key-123"), "the key is a dispatch-time value, not part of the digest input");
  assert.equal(server.requests.at(-1)!.headers["idempotency-key"], "key-123");
  assert.equal(h.result.effect, "confirmed");

  const query = tool({ method: "POST", path_template: "/echo", query: { a: { literal: 1 } } }, { effect: "write", dedup: contract({ query: "idem" }) });
  await call(query, {}, conn, { idempotencyKey: "key-456" });
  assert.equal(server.requests.at(-1)!.url, "/echo?a=1&idem=key-456");

  const bodyField = tool({ method: "POST", path_template: "/echo", body: { fields: { order_id: { literal: "o1" } } } }, { effect: "write", dedup: contract({ body_field: "idempotency_key" }) });
  await call(bodyField, {}, conn, { idempotencyKey: "key-789" });
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), { order_id: "o1", idempotency_key: "key-789" });

  const noBody = tool({ method: "POST", path_template: "/echo" }, { effect: "write", dedup: contract({ body_field: "idempotency_key" }) });
  await call(noBody, {}, conn, { idempotencyKey: "key-000" });
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), { idempotency_key: "key-000" });
  assert.equal(server.requests.at(-1)!.headers["content-type"], "application/json");

  // A deduplicated operation is never sent without its key (§16.2).
  const before = server.requests.length;
  const missing = await call(header, {}, conn);
  assert.equal(missing.result.effect, "not_started");
  assert.equal(missing.result.error?.code, "INVALID_CONFIG");
  assert.equal(server.requests.length, before);

  await assert.rejects(adapter.prepare(tool({ method: "POST", path_template: "/echo" }, { effect: "write", dedup: contract({ header: "Authorization" }) }), {}, prepCtx({}, conn)), isCode("INVALID_CONFIG"));
});

test("allowed_hosts: prepare rejects a host outside the allowlist; execute re-checks before sending", async () => {
  const def = tool({ method: "GET", path_template: "/echo" });
  const denied = connection(server.baseUrl, { allowedHosts: ["api.example.com"] });
  await assert.rejects(adapter.prepare(def, {}, prepCtx({}, denied)), (e: unknown) => SFieldError.is(e, "HOST_NOT_ALLOWED") && e.category === "authorization");

  const allowed = connection(server.baseUrl);
  const prepared = await adapter.prepare(def, {}, prepCtx({}, allowed));
  const before = server.requests.length;
  const result = await adapter.execute(prepared, execCtx(denied));
  assert.equal(result.effect, "not_started");
  assert.equal(result.error?.code, "HOST_NOT_ALLOWED");
  assert.equal(result.error?.retryable, false);
  assert.equal(server.requests.length, before, "nothing was sent");

  // An allowlist entry that is an IP literal must equal the resolved address.
  const mismatch = connection(`http://localhost:${server.port}`, { allowedHosts: ["localhost", "127.0.0.1"] });
  const viaName = await adapter.prepare(def, {}, prepCtx({}, mismatch));
  assert.equal(new URL(viaName.operation["url"] as string).hostname, "localhost");
});

test("a redirect response is refused and never followed", async () => {
  const def = tool({ method: "POST", path_template: "/redirect" }, { effect: "write" });
  const conn = connection(server.baseUrl);
  const before = server.requests.length;
  const { result } = await call(def, {}, conn);
  assert.equal(result.error?.code, "HTTP_REDIRECT");
  assert.equal(result.error?.retryable, false);
  assert.equal(result.transport.status, 302);
  assert.equal(result.payloadValid, false);
  assert.equal(result.effect, "unknown");
  assert.equal(server.requests.length, before + 1);
  assert.equal(server.requests.at(-1)!.url, "/redirect");
  const read = await call(tool({ method: "GET", path_template: "/redirect" }), {}, conn);
  assert.equal(read.result.effect, "none");
  assert.equal(read.result.error?.code, "HTTP_REDIRECT");
});

test("byte cap: reading stops once max_output_bytes is exceeded", async () => {
  const conn = connection(server.baseUrl);
  const read = await call(tool({ method: "GET", path_template: "/big" }), {}, conn, { maxOutputBytes: 1024 });
  assert.equal(read.result.error?.code, "INVALID_OUTPUT");
  assert.equal(read.result.error?.category, "validation");
  assert.equal(read.result.payloadValid, false);
  assert.equal(read.result.effect, "none");
  assert.equal(read.result.transport.status, 200);
  assert.ok(read.result.transport.bytes > 1024 && read.result.transport.bytes < 320 * 1024, `read ${read.result.transport.bytes} bytes`);
  // A 2xx already received means the mutation happened even though the body is unusable (§9.6).
  const write = await call(tool({ method: "POST", path_template: "/big" }, { effect: "write" }), {}, conn, { maxOutputBytes: 1024 });
  assert.equal(write.result.error?.code, "INVALID_OUTPUT");
  assert.equal(write.result.effect, "confirmed");
  // Under the cap the same body is fine.
  const fits = await call(tool({ method: "GET", path_template: "/big", response: "text" }), {}, conn, { maxOutputBytes: 400 * 1024 });
  assert.equal(fits.result.payloadValid, true);
  assert.equal(fits.result.transport.bytes, 320 * 1024);
});

test("timeout: a POST that times out has an unknown effect, a GET has none", async () => {
  const conn = connection(server.baseUrl);
  const write = await call(tool({ method: "POST", path_template: "/slow" }, { effect: "write" }), {}, conn, { timeoutMs: 200 });
  assert.equal(write.result.error?.code, "TOOL_TIMEOUT");
  assert.equal(write.result.error?.category, "availability");
  assert.equal(write.result.effect, "unknown");
  assert.equal(write.result.payloadValid, false);
  assert.ok(write.result.transport.durationMs < 1500, `took ${write.result.transport.durationMs} ms`);
  const read = await call(tool({ method: "GET", path_template: "/slow" }), {}, conn, { timeoutMs: 200 });
  assert.equal(read.result.error?.code, "TOOL_TIMEOUT");
  assert.equal(read.result.effect, "none");
  // The connection-level timeout caps the tool timeout.
  const capped = connection(server.baseUrl, { timeoutMs: 200 });
  const viaConnection = await call(tool({ method: "GET", path_template: "/slow" }), {}, capped, { timeoutMs: 5000 });
  assert.equal(viaConnection.result.error?.code, "TOOL_TIMEOUT");
  assert.ok(viaConnection.result.transport.durationMs < 1500);
});

test("cancellation through the run signal", async () => {
  const conn = connection(server.baseUrl);
  const aborted = new AbortController();
  aborted.abort();
  const before = server.requests.length;
  const early = await call(tool({ method: "POST", path_template: "/echo" }, { effect: "write" }), {}, conn, { signal: aborted.signal });
  assert.equal(early.result.effect, "not_started");
  assert.equal(early.result.error?.code, "CANCELLED");
  assert.equal(server.requests.length, before);
  const late = new AbortController();
  setTimeout(() => late.abort(), 100);
  const inFlight = await call(tool({ method: "POST", path_template: "/slow" }, { effect: "write" }), {}, conn, { signal: late.signal });
  assert.equal(inFlight.result.error?.code, "CANCELLED");
  assert.equal(inFlight.result.effect, "unknown");
});

test("expected_status: mismatches become HTTP_STATUS with a status-derived retry disposition", async () => {
  const conn = connection(server.baseUrl);
  const s500 = await call(tool({ method: "POST", path_template: "/status/500" }, { effect: "write" }), {}, conn);
  assert.equal(s500.result.error?.code, "HTTP_STATUS");
  assert.equal(s500.result.error?.category, "availability");
  assert.equal(s500.result.error?.retryable, true);
  assert.equal(s500.result.error?.status, 500);
  assert.equal(s500.result.effect, "unknown");
  assert.match(s500.result.error!.message, /^HTTP 500: status 500; authorization=none/);
  assert.equal(s500.result.payloadValid, false);

  const s404 = await call(tool({ method: "POST", path_template: "/status/404" }, { effect: "write" }), {}, conn);
  assert.equal(s404.result.error?.code, "HTTP_STATUS");
  assert.equal(s404.result.error?.category, "validation");
  assert.equal(s404.result.error?.retryable, false);
  assert.equal(s404.result.effect, "none");

  const s429 = await call(tool({ method: "GET", path_template: "/status/429" }), {}, conn);
  assert.equal(s429.result.error?.retryable, true);
  assert.equal(s429.result.error?.category, "availability");
  assert.equal(s429.result.effect, "none");

  // An expected non-2xx is the success path; an unexpected 2xx on a mutation is still a confirmed effect.
  const expected404 = await call(tool({ method: "DELETE", path_template: "/status/404", response: "text", expected_status: [204, 404] }, { effect: "destructive" }), {}, conn);
  assert.equal(expected404.result.error, undefined);
  assert.equal(expected404.result.payloadValid, true);
  assert.equal(expected404.result.effect, "confirmed");
  const wanted201 = await call(tool({ method: "POST", path_template: "/echo", expected_status: 201 }, { effect: "write" }), {}, conn);
  assert.equal(wanted201.result.error?.code, "HTTP_STATUS");
  assert.equal(wanted201.result.error?.retryable, false);
  assert.equal(wanted201.result.effect, "confirmed");
});

test("invalid JSON on a 200 POST: payload invalid, effect confirmed; empty JSON body is a null payload", async () => {
  const conn = connection(server.baseUrl);
  const { result } = await call(tool({ method: "POST", path_template: "/invalid-json" }, { effect: "write" }), {}, conn);
  assert.equal(result.payloadValid, false);
  assert.equal(result.error?.code, "INVALID_OUTPUT");
  assert.equal(result.error?.category, "validation");
  assert.equal(result.effect, "confirmed");
  assert.equal(result.transport.status, 200);
  const empty = await call(tool({ method: "DELETE", path_template: "/empty" }, { effect: "destructive" }), {}, conn);
  assert.equal(empty.result.payloadValid, true);
  assert.equal(empty.result.payload, null);
  assert.equal(empty.result.effect, "confirmed");
  assert.equal(empty.result.transport.status, 204);
});

test("response: text and artifact", async () => {
  const conn = connection(server.baseUrl, { classification: "confidential" });
  const text = await call(tool({ method: "GET", path_template: "/text", response: "text" }), {}, conn);
  assert.deepEqual(text.result.payload, { text: "hello, world" });
  assert.equal(text.result.payloadValid, true);

  const store = new InMemoryArtifactStore();
  const artifact = await call(tool({ method: "GET", path_template: "/artifact", response: "artifact" }), {}, conn, { artifacts: store });
  assert.equal(artifact.result.payloadValid, true);
  assert.equal(artifact.result.payload, undefined);
  const ref = artifact.result.artifact!;
  assert.equal(ref.mediaType, "image/png");
  assert.equal(ref.bytes, PNG_BYTES.byteLength);
  assert.equal(ref.classification, "confidential");
  assert.equal(store.size(), 1);
  assert.deepEqual(new Uint8Array(await store.get(ref, { tenantId: "t1", maxBytes: 1024 })), PNG_BYTES);
  assert.equal(artifact.result.transport.bytes, PNG_BYTES.byteLength);
});

test("credential values never appear in error messages, even when the server echoes them", async () => {
  const secret = "sk-echoed-secret-value-987654";
  const messages: string[] = [];
  for (const auth of [{ type: "bearer" as const, value: secret }, { type: "basic" as const, value: `user:${secret}` }, { type: "header" as const, name: "X-Api-Key", value: secret }]) {
    const conn = connection(server.baseUrl, { auth });
    const failing = await call(tool({ method: "POST", path_template: "/status/500" }, { effect: "write" }), {}, conn);
    messages.push(failing.result.error!.message);
    const invalid = await call(tool({ method: "GET", path_template: "/status/418" }), {}, conn);
    messages.push(invalid.result.error!.message);
    const redirect = await call(tool({ method: "GET", path_template: "/redirect" }), {}, conn);
    messages.push(redirect.result.error!.message);
  }
  const basic = Buffer.from(`user:${secret}`).toString("base64");
  for (const m of messages) {
    assert.ok(!m.includes(secret), m);
    assert.ok(!m.includes(basic), m);
    assert.ok(!/[\r\n]/.test(m) && m.length <= 300, m);
  }
  assert.ok(messages[0]!.includes("[REDACTED]"), messages[0]);
});

test("network failures before dispatch are not_started; a hang-up after sending leaves a mutation unknown", async () => {
  const closed = await TestServer.start();
  await closed.close();
  const refused = connection(`http://127.0.0.1:${closed.port}`);
  const write = await call(tool({ method: "POST", path_template: "/echo" }, { effect: "write" }), {}, refused);
  assert.equal(write.result.effect, "not_started");
  assert.equal(write.result.error?.code, "TOOL_UNAVAILABLE");
  assert.equal(write.result.error?.category, "availability");
  assert.equal(write.result.error?.retryable, true);
  assert.match(write.result.error!.message, /ECONNREFUSED/);

  const unresolvable = connection("http://sfield-does-not-exist.invalid", { allowedHosts: ["sfield-does-not-exist.invalid"] });
  const dnsFail = await call(tool({ method: "POST", path_template: "/echo" }, { effect: "write" }), {}, unresolvable);
  assert.equal(dnsFail.result.effect, "not_started");
  assert.equal(dnsFail.result.error?.code, "TOOL_UNAVAILABLE");

  const conn = connection(server.baseUrl);
  const hangup = await call(tool({ method: "POST", path_template: "/hangup" }, { effect: "write" }), {}, conn);
  assert.equal(hangup.result.error?.code, "TOOL_UNAVAILABLE");
  assert.equal(hangup.result.effect, "unknown");
  assert.equal(hangup.result.payloadValid, false);
  const readHangup = await call(tool({ method: "GET", path_template: "/hangup" }), {}, conn);
  assert.equal(readHangup.result.effect, "none");
});

test("conflict keys resolve into the prepared operation; reconcile answers unknown", async () => {
  const conn = connection(server.baseUrl);
  const def = tool({ method: "POST", path_template: "/echo" }, { effect: "write", conflictKey: { ref: "inputs.order_id" } });
  const prepared = await adapter.prepare(def, { order_id: "o-9" }, prepCtx({ order_id: "o-9" }, conn));
  assert.equal(prepared.conflictKey, "o-9");
  const outcome = await adapter.reconcile!(prepared, { principal: PRINCIPAL, signal: new AbortController().signal, callId: "c", runId: "r", connection: conn, intent: {} });
  assert.deepEqual(outcome, { effect: "unknown" });
});

test("plugin manifest and registration", () => {
  const plugin = httpPlugin();
  assert.equal(plugin.manifest.id, "http");
  assert.equal(plugin.manifest.apiVersion, 1);
  assert.match(plugin.manifest.buildDigest, /^sha256:[0-9a-f]{16,}$/);
  assert.deepEqual(plugin.manifest.requires, []);
  const registered: ToolAdapter[] = [];
  plugin.register({
    adapter: (a) => registered.push(a),
    tool: () => undefined,
    provider: () => undefined,
    retrievalType: () => undefined,
    contextTransform: () => undefined,
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.id, "http");
  assert.ok(registered[0] instanceof HttpAdapter);
  assert.equal(registered[0]!.operationSchema, HTTP_OPERATION_SCHEMA);
  assert.ok(httpAdapter() instanceof HttpAdapter);
});
