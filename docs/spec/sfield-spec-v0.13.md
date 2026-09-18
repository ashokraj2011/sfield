# Singularity Field — Agent Harness Specification

**Short name / CLI:** `sfield`  
**Proposed package scope:** `@sfield`  
**Primary entry point:** `SField`  
**Specification version:** 0.13, proposed  
**Configuration schema version:** 1  
**Date:** 6 September 2026  
**Status:** Design specification for implementation review

This revision keeps the v0.10 execution, authorization, and recovery semantics intact and amends four things: the dependency posture (§2 principle 13, §13.6, §21.1), the product's generality (§1, Appendices A–D as gated extensions that must use these contracts), four missing controls (loop detection §14.2, serialization stability §13.6, a named first provider §25.4, evaluation-bound approvals §5.4/§25.3), and a plain statement of the persistence burden (§17.2). §29 lists the changes. Package names, APIs, commands, and presets below are proposed contracts; their inclusion does not imply that an implementation or published package already exists.

`MUST` denotes a release requirement. `SHOULD` permits a documented exception. `MAY` denotes an extension. Sections marked **Service extension** or **Later extension** are outside the first release unless explicitly enabled; their contracts still constrain future compatibility.

**Reading guide:** §§1–7 define the product and integration experience; §§8–9 define tools and authorization; §§10–12 define memory, retrieval, and context; §§13–20 define execution and operations; §§21–33 contain packages, defaults, implementation details, a business scenario, release gates, change logs, and the glossary. Appendices A–E define gated extensions (coding profile, plan module, procedural learning, studio) and the sflow-lite lineage; they are outside the first release and must use the contracts of the main body.

## 1. Product definition

Singularity Field is an embeddable, vendor-neutral runtime for agents. It connects models to approved capabilities, retains scoped information with provenance, and assembles relevant context for each model call. Business applications are the first acceptance domain and shape the defaults; the same contracts serve coding, operations, and other domains through gated extensions (Appendices A–D).

The host application owns authentication, product experience, business systems, infrastructure, and deployment. The harness owns agent execution, tool-contract enforcement, memory lifecycle, context assembly, and execution records.

The principal user benefit is reuse: a team configures an integration once and exposes it to several agents without duplicating tool validation, retrieval, conversation handling, approvals, or failure accounting.

### 1.1 Product goals

| ID | Requirement |
|---|---|
| G01 | An application can embed the harness through one initialization API and one run/session API. |
| G02 | A business team can define an agent in one YAML or JSON file using existing host bindings. |
| G03 | Tools, model providers, retrieval sources, memory storage, and application infrastructure can be replaced independently. |
| G04 | The registry, memory service, and context manager can each operate with an external agent loop. |
| G05 | Common behavior works through defaults; advanced behavior is explicit and discoverable. |
| G06 | Business data access is authorized by principal and resource, not only by tool name. |
| G07 | A developer can inspect which tools and context were available, why they were selected, and what happened during execution. |
| G08 | Failed or interrupted external actions have honest, recoverable outcomes. |

### 1.2 Target use cases

Customer support, employee assistance, sales operations, procurement assistance, document processing, and internal business research are first-class examples. Each uses the same runtime with different tools, instructions, retrieval sources, and policy. Coding assistance, approved workflows, and procedural learning are extension domains (Appendices A–C); they reuse these contracts and are gated separately.

The harness MUST support both answering questions and performing authorized business actions. It MUST also support an agent that has no tools, an agent that has no long-term memory, and direct tool execution without a model.

### 1.3 Non-goals for the first release

- A workflow designer or distributed multi-agent collaboration system. The plan module (Appendix B) is a gated extension, not part of the first release.
- A coding assistant or host-shell execution in the first release. The coding profile (Appendix A) requires an environment-backed execution plugin and is gated on its conformance.
- Automatic tenant-wide procedural learning in the first release (Appendix C is gated), and autonomous policy modification at any time.
- A CRM, ERP, document repository, or authoritative business database.
- A bundled production identity provider, database server, queue, or administration portal.

Business orchestration can remain in host code. A later plan module may provide approved workflow definitions through the same execution contracts.

## 2. Design principles

1. **Small common path.** Starting one agent requires one config and host bindings, not a directory of mandatory policy files.
2. **Configure capabilities; implement integrations.** New tools within an adapter's supported operations can be configured. New execution semantics require trusted code implementing a plugin contract.
3. **Memory and context are separate.** Memory decides what is retained; context decides what is shown to a model now.
4. **Business systems remain authoritative.** Remembered facts carry source, freshness, and validity; critical state is refreshed from its source before acting.
5. **Identity originates at the host boundary.** Model arguments and request bodies cannot select their own principal or roles.
6. **Execution has one tool pipeline.** Built-in and custom tools share validation, authorization, approvals, budgeting, result handling, and records.
7. **Information never grants permissions.** Tool output, retrieved documents, preferences, and model output cannot expand capabilities.
8. **A view is not execution state.** Redacted audit views and shortened model context do not replace canonical results or protected checkpoints.
9. **Approval and deduplication solve different problems.** Permission to act does not prove that an earlier attempt did not succeed.
10. **Extensibility is explicit.** Plugins are installed by the host and granted named bindings. A model cannot install or grant a plugin.
11. **Own infrastructure semantics honestly.** Single-process durability and multi-replica coordination are distinct deployment capabilities.
12. **Measure complexity through contracts and behavior.** Conformance, bounded resources, usability, and measured overhead are the release gates; line counts are not.
13. **No vendor or framework SDK in core.** `@sfield/core` depends on a JSON Schema validator and a YAML parser; everything else is Node built-ins. Model providers are `fetch` + SSE adapters over two wire formats (§13.6), and the HTTP adapter uses the platform `fetch`. Plugins outside core may use maintained SDKs. The reason is independence from every vendor's release cadence and a core that can be read in one sitting, not a dependency count for its own sake.

## 3. Architecture and ownership

| Module | Responsibility | Works independently? |
|---|---|---|
| Config compiler | Parse, validate, resolve defaults/references, pin dependencies, emit immutable effective configuration | Yes |
| Plugin manager | Register supported extensions and bindings; validate requirements; manage lifecycle | Yes |
| Tool registry | Resolve and expose tool contracts; prepare and execute calls | Yes |
| Memory service | Conversation/working memory, explicit preferences and facts, provenance, update/forget | Yes |
| Retrieval service | Authorized source search, exact lookups, freshness, citation normalization | Yes |
| Context manager | Select, budget, transform, and explain model context | Yes |
| Model gateway | Compile model requests, normalize responses, stream events, account for usage | Yes |
| Runtime | Model–tool loop, run state, suspension, cancellation, recovery, verification | Uses the above |
| Policy/approval service | Effective capabilities, resource decisions, action approvals, current revocation checks | Shared |
| Persistence and audit | Durable transitions, execution records, protected content, artifacts | Shared |

The runtime does not expose adapter connection details to a model. A model sees tool descriptions, input contracts, and policy-safe usage guidance. Human approval requirements may be described to help the model plan, but credential and infrastructure information is hidden.

### 3.1 Trust boundary

Trusted components include the embedding host, approved configuration, installed plugin code, authorization callbacks, and persistence implementations. In-process code has host authority and MUST NOT be described as sandboxed by a Promise timeout or plugin permission declaration.

Untrusted inputs include model outputs, external tool responses, documents, attachments, end-user content, and unreviewed discovered tool metadata. External tool servers remain separate trust domains even when their protocol is supported.

Enforcing a sandbox requires an execution environment that constrains the process, filesystem, network, credentials, and resources. Arbitrary code execution is outside the default tool bundle.

## 4. Adoption experience

### 4.1 Integration layers

| Layer | Owner | Typical changes |
|---|---|---|
| Host wiring | Application/platform developer | Provider binding, connection resolver, storage, authorization callback |
| Shared capability catalog | Integration developer | Tool manifests, input/output schemas, retrieval-source registration |
| Agent configuration | Business application team | Instructions, allowed tools, memory options, context priorities, budgets |
| Session input | Authenticated application user | Message, attachments, explicit approval or memory instruction |

The first two layers are reused across agents. Agents MUST NOT repeat connection credentials or infrastructure setup.

### 4.2 Complete starter agent configuration

This file is a complete application configuration. It requires the host bindings `primary_llm` and `support_knowledge`, and the registered tool `crm.get_customer@1.0.0`. All other fields use defaults in §22.

```yaml
version: 1

models:
  default:
    binding: primary_llm

agents:
  customer_support:
    model: default
    instructions: >
      Help with customer support requests. Use current business information
      when it changes the answer. Explain missing information clearly.
    tools: [crm.get_customer@1.0.0]
    memory:
      conversation: true
      preferences: explicit
    context:
      max_input_tokens: 12000
      sources:
        - source: support_knowledge
          query: {ref: message.text}
          max_items: 5
          max_tokens: 2500
          required: false
    policy:
      preset: supervised
```

`instructions` is always literal text. Loading a file uses `instructions_file`, which is mutually exclusive with `instructions` and resolved relative to the configuration file. Instructions are packaged into the effective configuration and are not reread mid-run.

### 4.3 Host integration

The harness assembles the standard components; the application supplies what only it knows — credentials, business tools, identity, and business systems. Replacement interfaces for infrastructure exist (§6, §17, §23) but are advanced extension points, not the starting point.

**Local preset.** `preset: "local"` assembles a complete development installation:

| Component | Included default |
|---|---|
| Execution and conversation persistence | SQLite (`durable_single`), file under `./.sfield/` |
| Artifact storage | Local filesystem under `./.sfield/artifacts/` |
| Memory | SQLite-backed preferences and facts; exact listing without vectors |
| Retrieval | `local_files` source type over configured directories (§5.5) |
| Context management | Recent history, configured sources, token fitting with the §22 defaults |
| Secrets | Environment-variable resolver for `credential: {env: NAME}` references |
| Approvals and input | CLI interaction in the terminal running the process |
| Diagnostics | Console output; `sfield run inspect` over the local store |
| Authorization | An explicit local development principal (`tenant: local`, `subject: developer`) restricted to the capabilities configured in the file; no other principal is accepted |

Any component can be overridden individually by passing the corresponding `SFieldOptions` field; an explicit field always wins over the preset. The preset identifies itself as a development setup on every start (a console banner, `sf.health().preset = "local"`, and a `preset: local` field on every audit record) and refuses to load when `NODE_ENV=production` or when `deployment` is set to `service`. A second preset, `memory`, is the same assembly on `ephemeral` in-memory persistence for tests. Presets are installed packages (`@sfield/preset-local`, `@sfield/preset-memory`), resolved by name from the host's installed dependencies; a missing preset is a startup error naming the package to install. Production has no preset: authenticated identity, resource authorization, and the required infrastructure are configured explicitly (§4.7).

**Minimal application.** The generated `app.ts` (§4.6):

```ts
import { SField } from "@sfield/core";
import { tools } from "./tools.js";

const sf = await SField.create({ preset: "local", config: "./sfield.yaml", tools });

const session = await sf.sessions.open({ agent: "support" });
const run = await session.send({ message: { text: "What is the refund policy?" } });
console.log(await run.result());
```

For this convenience surface: the local preset supplies the development principal when `principal` is omitted (production requires it); a fresh request key is generated when `idempotencyKey` is omitted and exposed as `run.idempotencyKey` so the caller can see its retry boundary — a retried `send()` without the key is a *new* request, and an application that needs retry deduplication passes its own; provider, storage, retrieval, and tool bindings are constructed by the configuration compiler from validated configuration (§5.5). `session.close()` closes the local handle; it does not delete conversation data or cancel a durable run. `run.cancel()` requests cancellation. `sf.close()` drains runtime-owned work and releases resources. A session does not hold an execution lease while idle.

### 4.4 Ease-of-use acceptance criteria

- **Acceptance requirement.** A new developer can run the generated example after configuring one model credential, connect one real business tool without editing runtime internals, and add a second agent using the same integrations. This is a release gate measured in CI on a fresh machine (§25.4), with a ten-minute ceiling for the first run.
- The generated project contains no placeholders: every object it references exists and works.
- Replacing a retrieval source, a model, or persistence is a change to configuration or to one `SFieldOptions` field, with no change to agents or tools when the contract is compatible.
- Every validation failure contains a file/config path, stable code, explanation, and suggested correction.
- The documentation distinguishes executable samples from schema fragments and pseudocode.

### 4.5 Adoption levels

The main body is normative in full for production. It is not meant to be absorbed in full before a first run. Three levels state what a developer supplies and which sections apply; headings elsewhere carry the level at which they first apply.

| Level | Developer supplies | Sections that apply |
|---|---|---|
| **L1 — local** | the generated project (§4.6): one agent configuration, one function tool, one knowledge directory, one model credential | §4, §5.5, §8.3, §14, §22 defaults |
| **L2 — one real integration** | a `connections:` entry with a credential reference and an HTTP tool (wizard or manifest, §8.6), or `sf.registerTool` over existing code; CLI approvals still | + §8.1, §9, §16, §17.1 |
| **L3 — production** | PostgreSQL persistence, authenticated principals, a resource authorizer, an approval transport, optional evaluation-bound approvals (§16.6) | + §5.4, §12, §15, §18, §20 |

### 4.6 Generated project

```
npx @sfield/cli init support-agent --preset local
```

creates a project that runs after one model credential is supplied:

```
support-agent/
  sfield.yaml          # agent, model shorthand, one tool, one knowledge source (§5.5)
  instructions.md      # the agent's instructions, referenced by instructions_file
  tools.ts             # one working function tool: orders.get over sample data
  app.ts               # the minimal application of §4.3
  knowledge/
    refund-policy.md   # sample knowledge source read by the local_files retrieval type
  .env.example         # ANTHROPIC_API_KEY or an openai_compatible base URL and key
  package.json         # @sfield/core, @sfield/preset-local, @sfield/cli
```

```yaml
# support-agent/sfield.yaml — complete
version: 1

models:
  default:
    provider: anthropic
    model: "${env:SFIELD_MODEL}"
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
```

```ts
// support-agent/tools.ts — complete
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
      const order = orders.get(order_id);
      if (!order) throw new Error("NOT_FOUND");
      return order;
    },
  }),
];
```

Running: `cp .env.example .env`, set the credential, `npm start`. `sfield init --template business-agent` generates the L2 refund/support starter of §24 instead, with a `connections:` entry and the wizard-generated HTTP tool.

### 4.7 From local to production

Production is an incremental replacement of preset components; agents and tools do not change. Each replacement below is a working example, not an interface.

**Persistence: SQLite → PostgreSQL.**

```ts
import { postgresPersistence } from "@sfield/store-postgres";
import { s3Artifacts } from "@sfield/artifacts-s3";

const sf = await SField.create({
  config: "./sfield.yaml", tools,
  deployment: "service",
  persistence: postgresPersistence({ connectionString: process.env.DATABASE_URL! }),
  artifacts: s3Artifacts({ bucket: "acme-agents", prefix: "sfield/" }),
  // no preset: identity and authorization below are required
});
```

**Identity: development principal → authenticated principal.** The host maps its authenticated request to a `Principal` at the boundary; nothing in a request body can set it.

```ts
app.post("/chat", auth, async (req, res) => {
  const principal = { tenantId: req.user.orgId, subjectId: req.user.id, roles: req.user.roles, attributes: { plan: req.user.plan } };
  const session = await sf.sessions.open({ agent: "support", principal, conversationId: req.body.conversationId });
  const run = await session.send({ message: { text: req.body.text }, idempotencyKey: req.headers["idempotency-key"] as string });
  for await (const ev of run.events()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.end();
});
```

**Authorization: configured capabilities → resource authorizer.** The authorizer answers action-on-resource questions with expiring evidence (§9.2); this example delegates to an existing permission service.

```ts
const authorizer: Authorizer = {
  async authorize(req) {
    const ok = await permissions.check(req.principal.subjectId, req.action, `${req.resource.type}:${req.resource.id}`);
    return ok
      ? { decision: "allow", evidenceId: `perm:${req.runId}:${req.resource.id}`, expiresAt: inSeconds(300) }
      : { decision: "deny", code: "ACCESS_DENIED", reason: "permission service denied" };
  },
};
```

**Approvals: CLI → application transport.** Implement `ApprovalTransport.request(view) → Promise<void>` to notify the host UI; decisions arrive through `sf.approvals.decide` from an authenticated actor.

With these four objects the same `sfield.yaml`, `instructions.md`, and `tools.ts` run in production. `sfield doctor` lists which preset components are still in use, so a partial migration is visible rather than silent.

## 5. Configuration contract

### 5.1 Root structure

The root schema accepts only `version`, `includes`, `models`, `connections`, `sources`, `tools`, `agents`, and `extensions`. Deployment, credentials, installed code, and infrastructure objects belong to `SField.create` options or CLI host wiring.

| Field | Meaning |
|---|---|
| `version` | Required integer; `1` for this format |
| `includes` | Optional relative file paths; deterministic expansion, cycles rejected |
| `models` | Logical model IDs mapped to named host model bindings, or to provider shorthand (§5.5), with permitted overrides |
| `connections` | Shorthand connection definitions with credential references (§5.5); explicit `ConnectionResolver` bindings remain in host wiring |
| `sources` | Retrieval sources by registered type or explicit binding (§5.5) |
| `tools` | Dictionary of explicitly configured tool definitions, keyed by logical tool ID |
| `agents` | Dictionary of agent configurations, keyed by agent ID |
| `extensions` | Plugin-owned config keyed by plugin ID; unknown plugin keys rejected |

Agent fields are `model`, `instructions` or `instructions_file`, `tools`, `memory`, `context`, `policy`, `budget`, `output`, `runtime` (§14.7), and `extensions`. Plugin-specific fields MUST live under `extensions`; arbitrary unknown keys are errors.

All effective configurations MUST contain at least one registered model only when an agent or requested context transformation requires a model. A tool-only deployment may omit both `models` and `agents`.

### 5.2 Defaults and overlays

Defaults are expanded before hashing. Includes combine named dictionaries; duplicate definitions are errors. They do not apply hidden ordering-dependent overrides.

Environment overrides are supplied as an explicit ordered `overrides` option to `SField.create` or `--override` CLI flag. Dictionaries merge recursively; arrays replace entirely; `null` remains an actual null value. Deletion requires an explicit remove operation in an override document. The compiler produces a provenance map showing the source of every effective field. A plugin cannot override another plugin's registration.

Overrides MUST NOT grant capabilities beyond the host's grants. Production bindings have independent immutable identities; different effective bindings produce different execution configuration digests.

### 5.3 References and interpolation

The first release has no general expression language. Dynamic values use explicit bindings:

```ts
type ValueBinding =
  | { literal: JsonValue }
  | { ref: string; onMissing?: "error" | "omit" };
```

Allowed paths are rooted in `inputs` for tool operations, `message.text` and `run.inputs` for configured context queries, and explicitly declared host attributes exposed through `context.attributes`. Paths allow dot properties and fixed nonnegative array indices. Calls, operators, projections, wildcards, prototype properties, and secret references are rejected.

Missing values fail unless `onMissing: omit` is permitted by that operation field. Empty strings and null are not missing. There is no implicit string coercion for objects. Query strings, path segments, and JSON bodies are encoded by the adapter after typed resolution.

Static trusted instructions do not interpolate business or retrieved content. Dynamic content is assembled as labeled context blocks by §12. Computation beyond value lookup belongs in a registered transform or custom tool.

`${env:NAME}` is a compile-time substitution permitted only in the declared fields listed in §5.5; it is distinct from `ValueBinding` references and from `credential: {env: NAME}` secret references. The `environment.*` reference namespace exists only for tools bound to an environment plugin (Appendix A).

### 5.4 Compilation and lock manifest

Compilation performs parse, duplicate/unknown-key checks, schema validation, include expansion, default expansion, registration lookup, input/reference validation, capability checks, binding checks, and deterministic hashing.

Tool references are either `id@exact-version` or unversioned IDs. An unversioned reference is resolved only when the catalog contains one eligible version; ambiguity is an error. The emitted lock manifest pins the result. Production mode requires an approved/pinned lock manifest according to host deployment policy; it does not pick a newer installed version automatically. Host policy MAY set `require_eval`: an approval is then blocked — not warned — unless an evaluation report (§25.3) bound to the same digest meets the configured thresholds (minimum pass rate, maximum cost delta). Approval and evaluation records reference each other by digest; the option schema, record shapes, and validation errors are in §16.6.

The effective digest covers resolved config, instruction contents, tool schemas and operations, plugin build identities, non-secret binding identities, and schema/compiler versions. Runtime IDs, credentials, approval decisions, and the digest field itself are excluded. Canonical encoding follows JCS, with deterministic dictionary ordering and semantically ordered arrays preserved. [JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/info/rfc8785/).

Credential rotation updates credential versions but does not change logical action authorization when the resource and account remain the same. Changing the destination account, tenant binding, or endpoint identity invalidates affected prepared invocations.

### 5.5 Configuration shorthand

Shorthand lets validated configuration produce the host bindings of §6.3 without the application constructing them. The compiler builds `ModelBinding`, `ConnectionResolver`, and `RetrievalBinding` objects internally; the explicit `binding:` form remains for unusual providers and existing integrations, and the two forms cannot be mixed within one entry.

```yaml
models:
  default:
    provider: anthropic                 # anthropic | openai_compatible (§13.6)
    model: "${env:SFIELD_MODEL}"
    credential: {env: ANTHROPIC_API_KEY}
    base_url: https://api.anthropic.com # optional; required for openai_compatible
    params: {max_output_tokens: 4000}   # declared supported keys only (§22)
  fast:
    binding: fast_llm                   # explicit host binding, unchanged

connections:
  crm:
    base_url: https://api.crm.example.com/v2
    auth: {type: bearer, credential: {env: CRM_TOKEN}}   # bearer | header(name) | basic(credential pair)
    allowed_hosts: [api.crm.example.com]
    classification: confidential
    timeout_ms: 10000

sources:
  policies:
    type: local_files                   # registered retrieval type; local preset provides local_files
    path: ./knowledge
    include: ["**/*.md"]
  kb:
    binding: support_knowledge          # explicit host binding, unchanged
```

Rules:

- `${env:NAME}` substitution is permitted only in declared fields: `models.*.model`, `models.*.base_url`, `connections.*.base_url`, `sources.*.path`, and `extensions.*` fields a plugin declares substitutable. It is rejected everywhere else, including instructions, tool operations, schemas, and any model-visible field. Substituted values enter the effective configuration and its digest.
- `credential: {env: NAME}` is a *reference*, never a substitution. The compiler binds it to the environment secret resolver (or the host's `SecretResolver` when one is supplied); the value is resolved by the adapter at call time and never enters configuration, digests, model messages, or logs (§18.2). A missing credential is a startup error naming the variable.
- Shorthand entries receive a `BindingIdentity` derived from their non-secret fields (provider, model, base URL, host) so digests and client-pool keys behave as for explicit bindings.
- The root schema accepts `connections` and `sources` in addition to the fields in §5.1; the wizard in §8.6 writes to them.

## 6. Plugin and binding system

### 6.1 Plugin kinds

| Kind | Provides |
|---|---|
| Tool adapter | HTTP, approved SQL operations, MCP calls, or a business-specific execution family |
| Tool bundle | Versioned configured tools and/or trusted function handlers |
| Model provider | Request/response translation, capabilities, streaming, usage |
| Retrieval source | Search or lookup over an existing business knowledge system |
| Context transform | Deterministic filtering, formatting, reranking, or declared model-backed summarization |
| Memory backend | Reference implementation of memory/query persistence contracts |
| Persistence backend | Transactional execution state and audit implementation |
| Transport | Host notifications, approvals, or optional service API |

Plugins MAY provide several kinds. Implementations can use maintained SDKs inside plugin packages; the public contract remains provider-neutral. Plugins MUST be loaded from installed, pinned host packages. Config does not trigger package downloads or arbitrary dynamic imports.

### 6.2 Plugin manifest and lifecycle

```ts
interface PluginManifest {
  id: string;
  version: string;
  apiVersion: 1;
  coreCompatibility: string;
  buildDigest: string;
  configSchema?: JsonSchema;
  requires: Array<{ kind: BindingKind; name: string }>;
}

interface SFieldPlugin {
  manifest: PluginManifest;
  register(registrar: Registrar): void;
  start?(ctx: PluginStartContext): Promise<void>;
  health?(): Promise<HealthCheck>;
  stop?(ctx: { signal: AbortSignal }): Promise<void>;
}
```

`register` is synchronous, deterministic, and free of network/storage side effects. `Registrar` supports `adapter`, `tool`, `provider`, `retrievalType`, and `contextTransform` registration with unique IDs and config schemas. `start` runs only after configuration and binding validation; it initializes granted resources. Dependencies are topologically started and reverse-order stopped. Cycles or incompatible API versions fail initialization.

The manifest declares requirements, not permissions. Host grants and the authorizer determine access. An optional plugin health failure degrades only agents that need it; a required registration failure prevents startup.

### 6.3 Named host bindings

```ts
interface HostBindings {
  models?: Record<string, ModelBinding>;
  connections?: Record<string, ConnectionResolver>;
  retrieval?: Record<string, RetrievalBinding>;
}

interface BindingIdentity {
  id: string;
  revision: string;
  accountScope: string;
  classification: DataClassification;
}
```

`ConnectionResolver` resolves a named connection for an authenticated principal and tool. It returns a secret-free binding identity plus private client/credential material available only to its adapter. Agent YAML never contains credential values. Model bindings additionally identify accepted data classifications, region/routing policy, model limits, and versioned price tables.

Client pools MUST include tenant, effective binding revision, account scope, adapter build, and credential identity/version in their keys. Same-named tenant connections must not share clients unless the host explicitly proves they represent the same authorized resource.

## 7. Public SDK

### 7.1 Common types

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type JsonSchema = Record<string, unknown>;
type DataClassification = "public" | "internal" | "confidential" | "restricted";

interface Principal {
  tenantId: string;
  subjectId: string;
  roles: readonly string[];
  attributes: Readonly<Record<string, string>>;
}

interface MessageInput {
  text: string;
  attachments?: AttachmentRef[];
}

interface SendRequest {
  message: MessageInput;
  inputs?: JsonObject;
  idempotencyKey?: string;      // generated when omitted; see RunHandle.idempotencyKey
}

interface Session {
  readonly id: string;
  readonly conversationId: string;
  send(request: SendRequest): Promise<RunHandle>;
  close(): Promise<void>;
}

interface RunHandle {
  readonly id: string;
  readonly idempotencyKey: string;   // the caller's key, or the generated one — the retry boundary of this request
  events(opts?: { after?: string }): AsyncIterable<RunEvent>;
  snapshot(): Promise<RunSnapshot>;
  result(): Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}
```

`result()` resolves on terminal outcome or durable suspension and does not wait indefinitely for a human. A suspension result contains pending request IDs. A caller obtains a resumed handle through `sf.runs.resume`, or watches the persistent run through the service transport. Every event stream has an explicit delivery sequence and disconnect semantics (§19).

### 7.2 Surface areas

| API | Principal binding and purpose |
|---|---|
| `sf.sessions.open({agent, principal?, conversationId?})` | Create or authorize access to a conversation handle; `principal` may be omitted only under a development preset, which supplies its local principal |
| `sf.runs.start({agent, principal, request})` | Start a standalone run; conversation memory is absent |
| `sf.runs.get({runId, principal})` | Authorize and obtain a run handle |
| `sf.runs.resume({runId, principal})` | Reevaluate current authorization and claim eligible suspended work |
| `sf.approvals.decide({approvalId, actor, decision, comment?})` | Authenticated decision, independent of executor ownership |
| `sf.inputs.answer({requestId, actor, value})` | Validate and persist an answer to a suspended question |
| `sf.executions.open({principal, purpose, budget?})` | Create an auditable execution scope for an external loop |
| `sf.registry.list/describe/execute` | All accept an authenticated execution scope or principal as appropriate |
| `sf.memory.for(principal)` | Bound memory handle; further resource checks apply |
| `sf.context.build({scope, agent, message, transcript?})` | Build context for the internal or an external loop |
| `sf.context.explain({contextId, principal})` | Authorized explanation of a recorded context selection |
| `sf.conversations.history/export/delete({id, principal, ...})` | Explicitly authorized conversation operations |
| `sf.config.validate/compile/explain` | Host/control-plane access only |
| `sf.health()` / `sf.close({drainMs})` | Host lifecycle |

Opaque handles issued by core bind tenant, subject, authorization context, and execution identity. A remote client cannot provide an arbitrary internal `ExecContext`. The HTTP service derives principals from authentication and rejects client-supplied roles or tenant overrides.

Standalone `ExecutionScope` supports `modelCall` registration, `checkpoint`, `close`, and registry/context operations. An external loop must use the gateway or report model usage to get model accounting; tool accounting is guaranteed by `registry.execute`. The API MUST describe this boundary rather than claiming visibility into calls made outside the harness.

## 8. Tool registry

### 8.1 Tool definition

Each tool has an immutable `id@version` definition containing description, input and output schemas, implementation binding, resource mapping, declared effects, execution limits, approval requirements, and result presentation rules. Tool IDs use lowercase dot-separated segments; versions are exact semantic versions. A different implementation under the same ID/version is rejected when its digest differs from the lock manifest.

The registry can contain tools from configuration, installed bundles, and reviewed discovery imports. Every route produces the same internal `ToolDefinition`. Automatic discovery does not make a tool executable.

The following is a **root configuration fragment** defining an HTTP implementation of the starter tool. When using it, the host supplies the HTTP adapter and `crm` connection; it must not also register another implementation with the same ID/version.

```yaml
version: 1
tools:
  crm.get_customer:
    version: 1.0.0
    description: Fetch the current customer record by customer ID.
    adapter: http
    connection: crm
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
      timeout_ms: 5000
      max_attempts: 2
      retry_safety: repeatable
      max_output_bytes: 65536
```

The endpoint must return the declared output or a configured projection must produce it. Ignoring arbitrary response fields is not an implicit schema behavior; it is a one-line explicit one: `outputs.select: [id, tier, updated_at]` keeps the named top-level fields (dot paths permitted for nested objects) and drops everything else *before* output validation, and the projection is part of the tool digest. A tool declares either a closed `outputs` schema for the full response or `select` plus a closed schema for the selected fields. Required fields in business output schemas MUST match what downstream consumers rely on.

### 8.2 Input/schema rules

Application schemas use a supported, documented subset of JSON Schema draft 2020-12. The first release supports closed objects, arrays, strings, booleans, null, numbers, enums/constants, required fields, numeric/string/array bounds, local bundled references, and nullable unions. Additional constructs require explicit support in both local validation and provider compilation. Network schema references are disabled. Format validators are explicit and included in the schema/compiler digest. [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12).

Every object in a model-visible input schema MUST explicitly close additional properties. Optional properties are valid in the application schema; the provider compiler may translate them to required nullable wire fields under a reversible mapping. Local validation is always required, including provider-strict responses and direct SDK calls. Default insertion, if configured, occurs before authorization and is recorded; coercion and silently dropping invalid input fields are disabled.

### 8.3 Custom function tool

`defineTool` accepts the same metadata as a configured tool and a trusted handler. Types may be generated from the schemas; the runtime does not trust TypeScript types as validation.

```ts
const tool = defineTool({
  id: "orders.list",
  version: "1.0.0",
  description: "List recent orders for a customer.",
  inputs: orderQuerySchema,
  outputs: orderListSchema,
  resource: { type: "customer", id: { ref: "inputs.customer_id" } },
  policy: { effect: "read", action: "order.read", retrySafety: "repeatable" },
  async handler(inputs, ctx) {
    return orderService.listForCustomer(ctx.principal, inputs.customer_id, {
      signal: ctx.signal,
    });
  },
});
```

`authorization: {action, resource}` is accepted as the compact form of `policy.action` plus `resource` (§8.6). Configuration uses snake_case; TypeScript options use camelCase through generated mappings. The function handler has access only to documented context values, but host-provided service closures are trusted. All handler results and errors return through the common pipeline. Async timeouts are cooperative; hard isolation requires a worker/process environment.

### 8.4 Discovery and catalog selection

OpenAPI and MCP imports create candidate definitions with source identity, schema digest, and discovered metadata. The integration owner reviews resource mapping, output schema, effect class, and credential scope, then exports a pinned catalog. A server schema change produces drift; it does not silently alter an active tool. Protocol-specific trust assumptions and supported versions are declared by each plugin. MCP's published specification treats tool behavior annotations as untrusted unless obtained from a trusted server; importers MUST preserve that distinction. [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18).

`effectiveTools` is the intersection of registered versions, agent tools, host-surface grants, principal grants, mode grants, and current revocations. The default maximum exposed tools is 24. Below that limit, all eligible tools are serialized in stable order. Above it, selection is deterministic by configured pins and configured ranker; the selected set and scores are recorded. Ranker embeddings/model calls are budgeted. A search-tool extension may expand visibility only within the same effective set, never grant tools.

Authorization is rechecked when a tool is called even if it was exposed to the model.

Built-in interaction tools (`ask_user`, `memory.remember`, and an authorized memory-forget operation) are selected separately from business tools. Their enabling condition is the corresponding transport/memory setting plus explicit host capability grants. The effective tool list records them alongside business tools, and the same pipeline governs their calls. Enabling a memory store alone does not grant arbitrary memory writes or entity access.

### 8.5 Adapter contract

```ts
interface ToolAdapter {
  id: string;
  operationSchema: JsonSchema;
  prepare(def: ToolDefinition, input: JsonObject,
          ctx: PreparationContext): Promise<PreparedOperation>;
  execute(op: PreparedOperation, ctx: AdapterExecutionContext): Promise<AdapterResult>;
  reconcile?(op: PreparedOperation, ctx: ReconciliationContext): Promise<ReconcileResult>;
}
```

`prepare` resolves typed fields and resource identity without performing the business action. Any necessary authorization/metadata lookup is declared and separately metered; it cannot mutate the target. `execute` receives a private bound client, signal, attempt ID, logical call ID, stable idempotency key when supported, and byte limits. `AdapterResult` separates payload validity from knowledge of whether the external effect happened.

Reference adapters in release 1 are HTTP and trusted function tools. MCP and SQL are optional plugins after their conformance gates pass. SQL tools bind parameters and rely on database credentials/privileges for enforcement; statement classification alone is not an authorization boundary. Filesystem and shell are later environment-backed plugins.

HTTP destinations use fixed connection identities, encoded path parameters, controlled methods, header policies, and request/response byte caps. URL parameters cannot override origin, credentials, or protocol. Host allowlists are validated against the actual resolved addresses and redirect chain; redirects are disabled by default. Limits apply during streaming/decompression. Credential headers cannot be supplied by the model. Endpoint-level permissions remain required even on an allowed host.

### 8.6 Two tool paths

**Existing application code — `sf.registerTool`.** The same metadata as `defineTool` (§8.3), registered on the instance at startup; the adapter lifecycle, the pipeline, and the audit plumbing are the harness's job.

```ts
sf.registerTool({
  id: "orders.get", version: "1.0.0",
  description: "Get an order by its ID.",
  inputs: orderInputSchema,
  outputs: orderOutputSchema,
  authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } },
  handler: ({ order_id }, ctx) => orderService.get(ctx.principal, order_id, { signal: ctx.signal }),
});
```

`authorization` is the compact form of `policy.action` plus `resource`; `effect` defaults to `read` for `registerTool` and must be stated for mutations. Registration after the first run is rejected; the tool set of a running instance is fixed by its lock manifest.

**Existing APIs — the wizard.** `sfield tools add` asks for the connection (or creates one under `connections:`), the operation (method and path template with parameters), input and output schemas (typed by hand, imported from an OpenAPI operation, or inferred from a sample response and then reviewed), the resource permission (`action`, `resource.type`, `resource.id` reference), and the effect class. It writes a validated `tools.<id>` entry and, for mutations, insists on `retry_safety` and a deduplication contract or marks the tool `requires_approval: true`. A manifest file with the same fields can be supplied non-interactively (`sfield tools add --manifest orders.yaml`).

## 9. Policy, authorization, and tool execution

### 9.1 Effects and capabilities

`effect` is `read`, `write`, or `destructive`. It describes business impact: observation, permitted mutation, or irreversible/high-impact mutation. It does not describe whether a process can write scratch files or use network access. Execution capabilities such as network destination, credential scope, filesystem access, and code execution are separately granted by the host/environment.

| Preset | Allowed effects | Mandatory action approval |
|---|---|---|
| `read_only` | read | Any stricter tool/host requirement |
| `supervised` | read, write, destructive | Every write or destructive call |
| `bounded_auto` | read, write, destructive | Destructive calls; writes also require explicit host grants for autonomous execution |

Defaults are scoped by effect class so reads are not taxed with mutation-grade ceremony: `policy.effect` is always required (one word); `policy.action` defaults to the tool id; `resource` is required for `write` and `destructive` tools, and a `read` tool without one receives `resource: {type: "tool", id: <tool id>}` with a validation *note* (not an error) so the authorizer still sees a resource. Mutations keep the full requirements unchanged.

An agent can only narrow its host grants. Tool-specific approval rules and host requirements are cumulative. No “admin” role automatically bypasses tool policy; explicit host authorization rules must define privileged actions. Internal run bookkeeping is a runtime operation, not a fictitious business read tool.

### 9.2 Resource authorizer

```ts
interface AuthorizationRequest {
  principal: Principal;
  action: string;
  resource: { type: string; id: string; bindingIdentity: BindingIdentity };
  argumentsDigest: string;
  agentId?: string;
  runId: string;
  effect: "read" | "write" | "destructive";
}

interface Authorizer {
  authorize(req: AuthorizationRequest): Promise<
    | { decision: "allow"; evidenceId: string; expiresAt: string }
    | { decision: "deny"; code: string; reason: string }
  >;
}
```

This is a representative tool-action request. Read, memory, retrieval, audit, and approval APIs use corresponding resource types through the same host authorization service. Implementations MUST NOT invent globally trusted namespaces from caller strings. Namespace identifiers are structured tuples internally and safely encoded at storage boundaries.

If the authorizer is unavailable or evidence has expired, the affected action fails closed. Dynamic authorizations are rechecked immediately before dispatch; target-side controls remain necessary for state changes between check and action.

### 9.3 Pipeline

1. Resolve the pinned tool and authenticated execution scope.
2. Validate inputs; apply declared defaults.
3. Run registered preparation hooks; revalidate any mutation.
4. Prepare the secret-free operation and concrete resource/effect/capabilities.
5. Evaluate host and agent permissions, resource authorization, evidence prerequisites, output-data routing constraints, rate limits, and budget availability.
6. Create the immutable `PreparedInvocation`; collect required action approval. Approval-needed calls persist and suspend before dispatch.
7. For an executable batch, atomically claim calls and reserve budgets. Recheck current authorization/revocation, binding identity, approval validity, and ownership.
8. Persist each dispatch intent durably; obtain the private client/credential material; dispatch the approved operation.
9. Record observed effect and transport result; validate the business output; store the canonical result or artifact; produce permitted views.
10. Commit the result and accounting state, emit durable events, and make the result available to the runtime.

Read calls also receive durable logical call IDs. Tool intents MUST not be dispatched if durable recording fails. External execution and local persistence cannot be one transaction; §16 governs that interval.

### 9.4 Prepared invocation

```ts
interface PreparedInvocation {
  callId: string;
  runId: string;
  principalIdentity: { tenantId: string; subjectId: string };
  toolRef: string;
  toolDigest: string;
  bindingIdentity: BindingIdentity;
  resource: { type: string; id: string };
  normalizedInputs: JsonObject;
  operation: PreparedOperation;
  effect: "read" | "write" | "destructive";
  configDigest: string;
  prerequisiteEvidence: string[];
  digest: string;
}
```

Protected digests bind normalized values, not redacted displays. The digest excludes its own field and transient authorization expiry timestamps but binds evidence identities. If evidence expires, it must be refreshed for the same operation; changed evidence content invalidates affected approval when its predicate or result changes. Hooks cannot mutate a prepared invocation. A changed tool argument, resource, command, attachment content, or binding starts a new preparation and invalidates the old action approval.

### 9.5 Prerequisites

Prerequisites are configured evidence checks with an action/resource mapping and an explicit predicate. For example, refund authorization requires a current eligibility result for the same order and amount, not merely any prior successful eligibility call. Evidence contains resource ID, argument digest or constrained fields, source version, result, validity interval, and issuer.

Release 1 provides a trusted host `prerequisites` callback for these checks. A general policy expression language is deferred. The runtime records each predicate's evidence and decision. Cached evidence cannot authorize a changed resource or stale business state.

### 9.6 Tool result contract

```ts
interface ToolResult {
  callId: string;
  toolRef: string;
  status: "succeeded" | "failed" | "outcome_unknown";
  effect: "not_started" | "none" | "confirmed" | "unknown";
  output?: JsonValue;
  outputRef?: ArtifactRef;
  error?: { code: string; category: ErrorCategory; message: string };
  meta: { attempts: number; durationMs: number; bytes: number };
}
```

Inline output and output reference are mutually exclusive. A valid result may have a separately shortened model view with `partial: true`; the canonical business result stays intact. A mutation returning invalid JSON can have `status: failed, effect: confirmed` or `effect: unknown`. The model must not be told that a refund failed merely because its response violated a schema.

## 10. Memory service

### 10.1 Memory categories

| Category | Purpose | Scope | Default |
|---|---|---|---|
| Working | Run-local scratch state and intermediate results | Run | Enabled |
| Conversation | Messages, durable summaries, linked tool references | Conversation | Enabled for sessions |
| Preference | Explicitly confirmed communication or service preferences | Subject within tenant | Explicit writes only |
| Fact | Useful sourced facts with validity and provenance | Subject, or authorized business entity | Disabled |
| Knowledge | Existing policy manuals, KBs, documents | Source ACL, often tenant/team | Retrieved through bindings; not automatically copied into memory |

`constraint` is not a new permission-bearing memory category. A remembered preference may influence style or task handling within current policy; it never authorizes a standing financial/business action. Procedural playbooks are a later extension.

### 10.2 Memory item

```ts
interface MemoryItem {
  id: string;
  version: string;
  scope: MemoryScope;
  kind: "preference" | "fact" | "summary";
  content: string;
  structured?: { key: string; value: JsonValue };
  origin: "user_explicit" | "user_confirmed" | "trusted_source" | "derived";
  provenance: Array<{
    sourceType: "message" | "tool" | "document" | "host";
    sourceId: string;
    sourceVersion?: string;
    messageSpan?: { start: number; end: number };
    observedAt: string;
  }>;
  classification: DataClassification;
  validFrom?: string;
  validUntil?: string;
  expiresAt: string;
  status: "active" | "superseded" | "disputed";
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
}
```

`MemoryScope` is a tagged scope: subject, conversation, or entity. It carries tenant plus its subject/conversation/entity identity. Entity memory requires explicit resource authorization on both reads and writes. There is no unrestricted global scope or cross-tenant search. Shared knowledge follows its source ACL.

Confidence, where supplied by an extraction plugin, is explicitly an uncalibrated estimate unless measured otherwise. It does not override provenance, freshness, user correction, or access controls.

### 10.3 Writes and extraction

`preferences: explicit` enables host writes and the built-in `memory.remember` tool only for directly requested or confirmed preferences. The model's call alone is not proof of confirmation. The tool binds the candidate to source message IDs and an authorized user confirmation event. Ambiguous memory requests use the input mechanism. Secrets and authentication material cannot be remembered through this API.

The host may register authoritative synchronization for facts. Such writes include source revision and expiry. Automatic extraction is off by default. An optional extraction extension produces **candidates**, validates quoted source spans/roles, and subjects them to configured confirmation and sensitivity rules before activation. It cannot directly mark assistant-generated statements as user-confirmed facts.

Memory writes, edits, imports, and forgetting use the same memory authorization and audit path regardless of caller. A host-side bulk import includes origin and provenance; it does not bypass scope checks. A preference update uses optimistic concurrency; conflict returns `VERSION_CONFLICT`, rather than silently overwriting a newer correction.

### 10.4 Memory API

```ts
interface MemoryHandle {
  list(filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>>;
  get(id: string): Promise<MemoryItem | null>;
  put(input: NewMemoryItem, opts: { idempotencyKey: string }): Promise<MemoryItem>;
  update(id: string, patch: MemoryPatch, opts: { ifVersion: string }): Promise<MemoryItem>;
  forget(target: MemoryTarget, opts: { idempotencyKey: string }): Promise<DeletionReceipt>;
  export(filter: MemoryFilter): Promise<ArtifactRef>;
}
```

The handle is principal-bound. Scope changes, origin promotion, and provenance removal are not arbitrary patch operations. API filters cannot escape the authorized scope. Listing and export return paginated or streamed results with limits.

### 10.5 Freshness and conflicts

- Every stored fact has an observation time, source identity, and validity/expiry. Current balances, eligibility, inventory, and transaction status SHOULD be retrieved from the business system at action time.
- Expired items are excluded from normal retrieval immediately, independently of cleanup jobs.
- Explicit corrections supersede matching preferences; the supersession link preserves lineage subject to retention/erasure.
- Conflicting facts with different sources are marked disputed or presented with source and time. Embedding similarity alone cannot decide which one is true.
- Conversation summaries are derived context and do not become authoritative facts.
- Caches and memory items MUST expose their freshness status to context assembly.

### 10.6 Retention and deletion

Defaults are 30 days for conversation content, 365 days for preferences, and 30 days for explicitly enabled facts unless their source validity is shorter. Host policy may shorten these or approve a different retention profile. Audit-content retention is separately configured; a conversation deletion does not silently claim to erase a required audit copy.

`forget` immediately makes targeted memory unavailable and schedules deletion from indexes and dependent summaries. It records a content-free deletion receipt. Active run context is invalidated at the next safe boundary; an already sent provider request cannot be recalled. `delete conversation` removes its content and items derived solely from it unless the user explicitly saved an independently confirmed preference with a separate retention purpose.

Every deletion has a durable generation marker. Extraction/indexing jobs check that marker before writing, preventing resurrection by old queued work. Provenance supports deletion or rebuilding of derivatives. Vector indexes are query acceleration; canonical memory records remain the final authority for existence, scope, validity, and deletion.

Default storage caps are 500 active preferences and 1,000 active facts per subject; hosts can set smaller limits or explicit larger allocations. Reaching a cap rejects a new write with `MEMORY_CAPACITY` and permits updates/forgetting. Explicit user preferences are not silently evicted by a relevance score. Conversation storage is bounded by retention and host byte quotas; oversized imports are rejected before bulk mutation.

Full principal erasure, key destruction, retained-copy policy, and service-level erasure progress are defined in §18.4. First-release memory controls MUST disclose which physical deletion operations are supported by the bound backend.

## 11. Retrieval sources

### 11.1 Contract

```ts
interface RetrievalQuery {
  principal: Principal;
  text: string;
  filters: Readonly<Record<string, JsonValue>>;
  maxItems: number;
  maxBytes: number;
  signal: AbortSignal;
}

interface RetrievedItem {
  id: string;
  sourceId: string;
  sourceVersion: string;
  title?: string;
  text: string;
  citation: { label: string; uri?: string; locator?: string };
  classification: DataClassification;
  observedAt: string;
  validUntil?: string;
  score?: number;
  aclEvidence: string;
}

interface RetrievalBinding {
  identity: BindingIdentity;
  search(query: RetrievalQuery): Promise<{ items: RetrievedItem[]; partial: boolean }>;
  authorizeItem(item: RetrievedItem, principal: Principal): Promise<boolean>;
}
```

Native enterprise search, keyword search, vector search, and exact business lookup are interchangeable through adapters where their semantics fit. Embeddings are optional; context management must work without a vector database.

Authorization-aware filtering SHOULD happen at the source before ranking. Core also verifies returned items before disclosure. Rejecting unauthorized hits after a global top-k may reduce recall; adapters must document this limitation and use bounded refill when necessary. Counts and error messages must not disclose hidden records.

### 11.2 Source configuration

Each agent `context.sources` entry has `source`, `query`, `max_items`, `max_tokens`, `required`, optional `timeout_ms`, optional fixed `filters`, and optional `max_age_seconds`. Filters provided by an agent can narrow but cannot override ACL filters derived from the principal. Query rewriting and reranking are optional named transforms with recorded inputs and costs.

A failed required source ends preparation with `REQUIRED_CONTEXT_UNAVAILABLE`. A failed optional source emits a context omission and allows execution with explicit missing-evidence metadata. The assistant must not imply that an unavailable source was checked. An empty authorized result is different from a failed lookup.

### 11.3 Citations and attachments

Each accepted item receives a run-local citation ID such as `source_3`. The answer renderer maps these IDs to safe labels/links after verifying access. Models cannot create privileged download URLs. Unresolvable citation IDs are flagged by output validation.

Attachments enter through `sf.attachments.put({principal, ...})` or a host-owned reference resolver. An `AttachmentRef` is an opaque ID plus content digest, media type, size, and classification; paths or arbitrary tenant blob keys are not accepted from the model. Text extraction is bounded by time, bytes, and tokens. Images/documents are routed only to capable, authorized providers. Unsupported content produces an explicit unavailable representation; it is not silently described as inspected.

URL ingestion, when enabled, uses the same network restrictions as HTTP tools. Memory extraction does not read attachment contents by default. Attachment retention follows the owning conversation or standalone run.

## 12. Context management

### 12.1 Responsibility

The context manager constructs a provider-neutral `ContextPacket` for a specific model call. It determines relevance, source access, freshness, token allocation, and explicit omission. It does not execute arbitrary business actions or write durable facts as a side effect of retrieval.

### 12.2 Context packet

```ts
interface ContextBlock {
  id: string;
  kind: "instruction" | "current_message" | "history" | "summary"
      | "preference" | "fact" | "retrieval" | "tool_result" | "attachment";
  sourceIds: string[];
  authority: "host_instruction" | "user_input" | "reference_data";
  classification: DataClassification;
  content: ProviderNeutralContent;
  tokens: number;
  required: boolean;
  freshness: "current" | "stale" | "unknown";
}

interface ContextPacket {
  id: string;
  runId: string;
  modelBindingDigest: string;
  blocks: ContextBlock[];
  tools: ExposedTool[];
  budget: { inputLimit: number; outputReserve: number; estimatedInput: number };
  omissions: Array<{ sourceId: string; reason: string }>;
  transformations: Array<{ type: string; sourceIds: string[]; resultId: string }>;
  citations: Record<string, CitationTarget>;
  digest: string;
}
```

`ProviderNeutralContent` preserves typed text, media references, and provider-owned opaque blocks where applicable. Context metadata and source identifiers never become permission claims. The packet digest excludes its own digest and binds canonical selected content, model/schema mapping, and tool definitions. Audit stores a permitted view of the packet; exact protected content is stored only under the execution retention policy.

### 12.3 Assembly algorithm

1. Resolve the run's immutable agent configuration and current host restrictions.
2. Authorize the target model route for all candidate data classifications.
3. Load the current message, protected instructions, and recent conversation history.
4. Retrieve enabled memory categories and configured sources within per-source limits.
5. Filter by ACL, deletion marker, freshness, policy, and supported content types.
6. Resolve conflicting or duplicate content by source identity/version; retain material disagreements with attribution.
7. Select the effective tool definitions and compile their schema/token overhead for the selected provider.
8. Calculate input allowance from the provider context limit, output reserve, protocol/tool overhead, safety margin, and agent `max_input_tokens`.
9. Allocate optional content using configured source priority and relevance, then fit transformations as necessary.
10. Validate tool-call/result pairing, mandatory blocks, citation mapping, classification, and provider compatibility.
11. Persist the selection explanation and return the packet. Model dispatch follows separate budget reservation.

### 12.4 Budget and priority rules

The final serialized request MUST fit:

`serialized_input_tokens + reserved_output_tokens + safety_margin <= model_context_limit`.

`context.max_input_tokens` is an additional ceiling on total serialized input, including instructions and tool definitions. Per-source `max_tokens` values are ceilings, not reserved entitlements. Defaults allocate remaining optional capacity in order: recent history, explicit preferences, fresh facts, configured retrieval priority, older summary/history. Agent configuration can reorder optional categories with `context.priority`, but cannot make untrusted text into trusted instruction.

Mandatory content is the trusted instructions, current user message, provider-required continuation blocks, and complete pending tool-call/result groups. If this content alone does not fit, fail `CONTEXT_LIMIT` before calling the provider and report what requires reduction. Never silently truncate the user's current request or a required policy instruction.

Token counts use provider counting or a declared estimator with a conservative margin. Estimation uncertainty is surfaced in packet metadata; the runtime does not claim exact accounting from an approximation.

### 12.5 Fitting strategies

| Strategy | Behavior | Default |
|---|---|---|
| Deduplicate | Remove repeated source ID/version content while retaining citations | On |
| Shorten tool view | Use a schema-aware summary/projection or bounded text excerpt; label partial | On |
| Drop optional low-priority blocks | Omit complete blocks and record why | On |
| Summarize old history | Declared model call with provenance; preserve decisions, unresolved work, and source references | Off until configured |
| Retrieve larger result on demand | Keep an authorized artifact reference and offer an explicit read tool | When the tool supports it |

Summarization consumes the same execution budget, must fit its own request, and cannot recursively trigger summarization without a hard bound of one context-fit summarization per model turn. If it fails or budget is insufficient, use permitted dropping strategies or fail if required content cannot fit. Stored conversation history is append-only under its retention lifecycle; the fitted view is separate.

Provider-signed/opaque blocks MUST remain byte-faithful when required by the adapter; transformations treat the required continuation group atomically. Fallback to another provider must explicitly convert permitted context or reject incompatible continuation.

### 12.6 Explainability

`sf.context.explain` returns each included/omitted block's source, authorization outcome, freshness, token count, rank, transformation, and omission reason. Content remains access-controlled. A normal user sees only information they may access; administrators do not receive raw secrets by default.

Example omission reasons are `token_budget`, `stale`, `source_unavailable`, `unsupported_media`, `duplicate`, and `deleted`. Unauthorized details use a non-disclosing reason. Developers can compare two packet explanations across configurations to understand changes in answers.

### 12.7 Prompt authority

Only approved host instructions occupy the trusted instruction channel. Retrieved documents, business facts, tool output, and memory are labeled reference data in provider-appropriate message blocks. User preferences remain subordinate to current user instructions and host policy. A summary of a prior tool result cannot become a system instruction.

This is an authority rule enforced by tools/policy plus careful prompt construction; it is not a claim that prompt injection becomes impossible. Sensitive outgoing actions are independently authorized against exact resources and arguments.

## 13. Model gateway

### 13.1 Provider contract

```ts
interface ModelProvider {
  id: string;
  describe(binding: ModelBinding): Promise<ModelCapabilities>;
  compile(request: NeutralModelRequest): Promise<CompiledModelRequest>;
  stream(request: CompiledModelRequest, opts: {
    signal: AbortSignal;
    attemptId: string;
  }): AsyncIterable<ModelStreamEvent>;
  countTokens?(request: CompiledModelRequest): Promise<number>;
}
```

Capabilities include input/output limits, tool use, supported schema subset, structured output, streaming usage, media, opaque continuation requirements, and token accounting semantics. An adapter can narrow declared capabilities, never widen host permission. `compile` returns a reversible tool-name/argument mapping, a semantic-equivalence report, serialized overhead, and recorded degradations. Unsupported required semantics fail before dispatch.

### 13.2 Tool/schema translation

Provider wire names are stable aliases for exact registry versions. Alias encoding MUST avoid collisions, satisfy provider limits, and round-trip to one tool definition. Provider-strict generation supplements local validation; it never replaces it. Schema changes that cannot preserve required business semantics are errors unless the host explicitly permits post-validation fallback.

Parallel tool results remain one logical result batch in the neutral transcript. Adapters map that batch to the provider's actual message structure while retaining call IDs and order. They MUST NOT force a provider-specific user/tool role shape onto every provider.

Compiled requests are byte-stable for a given packet: tool definitions serialized in stable order, deterministic key order, and no per-call values (timestamps, run IDs) in the instruction channel. Provider prompt caches and record/replay both depend on this; §13.6 states the rule and the contract test proves it.

### 13.3 Streaming and completion

Each provider attempt yields exactly one terminal `done` or `error`, with optional preceding deltas. Tool calls are executed only from a fully parsed final response; partial streamed arguments never authorize execution. Text deltas are provisional and may be withdrawn/replaced by the final result. The host UI must distinguish provisional generation from a verified outcome.

| Normalized stop reason | Runtime action |
|---|---|
| `end_turn` | Candidate completion; validate output and required verifiers |
| `tool_use` | Validate and preflight a complete tool batch |
| `continue` | Continue with preserved provider content; no completion and no fabricated user message |
| `max_tokens` | Incomplete response; optional bounded continuation if safe; otherwise `INCOMPLETE_OUTPUT` |
| `stop_sequence` | Candidate completion, as `end_turn`: the matched sequence is excluded from output and recorded on the attempt; output validation and required verifiers run unchanged; a structured-output agent whose response was cut by a stop sequence fails validation rather than being repaired silently |
| `refusal` | Complete with `refused`; not a successful business action |
| `content_filter` | Stop with `filtered`; do not fallback around the restriction by default |
| `context_exceeded` | One bounded refit if authorized; otherwise fail |
| `error` | Retry/fallback according to attempt classification and remaining budget |

Absence of tool calls alone does not imply completion. A structured output must pass local schema validation. Invalid output may trigger at most the configured repair limit, charged as new attempts/calls as appropriate.

### 13.4 Retry and fallback

Provider retries are transport attempts, each separately metered. Retryable categories are explicit per adapter; generic 4xx errors are not automatically retried. A credential refresh is one bounded, separately recorded attempt and cannot make a non-idempotent tool retry safe.

Fallback models are explicit logical references in `models.<id>.fallback`. Before switching, recheck data routing/classification, schema support, context capacity, opaque-block compatibility, and budget. Rebuild and record the context packet. Refusal or filtering does not trigger fallback by default. Once deltas have been shown, a retry emits a generation-reset event or waits to publish a validated final response; it cannot silently concatenate two answers.

### 13.5 Usage

Each attempt records input, output, reasoning, cache read/write, provider request identity, and whether counts are reported or estimated. Adapter accounting declares which counters overlap. Price computation uses disjoint billable categories and a pinned price-table version. Failed or disconnected attempts may have unknown usage; §15 defines conservative accounting.

### 13.6 Reference provider adapters

Two adapters ship inside `@sfield/core`, both plain `fetch` + SSE with no SDK (principle 13). Together they cover the market: the Anthropic Messages format, and the OpenAI-compatible chat-completions format implemented by most hosted vendors, local runtimes, and routers. A vendor's native API beyond these is a `@sfield/provider-*` plugin implementing §13.1.

| Neutral | `anthropic` (Messages API) | `openai_compatible` (chat completions) |
|---|---|---|
| Endpoint / auth | `POST {base_url}/v1/messages`; `x-api-key`, `anthropic-version` | `POST {base_url}/chat/completions`; `Authorization: Bearer` |
| Instructions | top-level `system` blocks; cacheable prefix marker | leading `{role: "system"}` message (binding option: fold into first user turn) |
| Tool definitions | `{name, description, input_schema, strict}` | `{type: "function", function: {name, description, parameters, strict}}` |
| Assistant tool calls | `tool_use` block, `input` object | `tool_calls[]`, `function.arguments` JSON string |
| Result batch | `tool_result` blocks in one `user` message, nothing else in it | one `{role: "tool", tool_call_id}` message per result |
| Structured output | `output_config.format = {type: "json_schema", schema}` | `response_format = {type: "json_schema", json_schema: {name, schema, strict}}` |
| Opaque blocks | reasoning blocks with signatures round-tripped byte-faithfully | vendor-specific or absent; captured opaque if present |
| Streaming | typed events per content-block index; usage cumulative in `message_delta` | `chat.completion.chunk` deltas; tool-call fragments assembled by index; `stream_options.include_usage`; `data: [DONE]` |
| Stop reasons | `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`→`continue`, `refusal`, `model_context_window_exceeded`→`context_exceeded` | `stop`→`end_turn`, `tool_calls`→`tool_use`, `length`→`max_tokens`, `content_filter` |
| Usage | `input_tokens`, `output_tokens`, cache read/creation | `prompt_tokens`, `completion_tokens`, vendor cache fields when present |
| Token counting | count endpoint | not standard; estimator with declared margin (§12.4) |

The `openai_compatible` binding carries a `quirks` set for documented divergences (`system_as_user`, `no_stream_usage`, `no_strict`, `json_mode_only`, `tool_choice_unsupported`); its conformance cassettes are recorded against at least one hosted vendor and one local runtime, because that is where the format diverges. Capabilities a binding declares must be proven by a passing cassette; a declared capability without one fails validation.

**Serialization stability rule.** For a given context packet and model binding, the compiled request bytes are identical across attempts and across workers. Tools are sorted by alias, object keys are canonical, and nothing per-call enters the instruction channel. The per-adapter contract test compares two compilations of the same packet byte-for-byte.

**Contract cassettes** per adapter: text-only turn; parallel tool calls with results round-tripped; structured output at the declared level; strict tool schema enforced or locally caught; opaque blocks round-tripped when declared; `max_tokens` truncation; in-stream error; cancellation mid-stream; usage present or marked estimated; `continue` when declared.

## 14. Agent runtime and conversations

### 14.1 Run lifecycle

| State | Meaning | Legal next states |
|---|---|---|
| `queued` | Durably accepted input; not yet owned | running, cancelled, expired |
| `running` | Worker owns current execution epoch | waiting_approval, waiting_input, suspended, reconciliation_required, terminal |
| `waiting_approval` | Prepared invocation or batch awaits a decision | queued, denied, expired, cancelled |
| `waiting_input` | A schema-bound question awaits an authorized answer | queued, expired, cancelled |
| `suspended` | Safe checkpoint exists; execution intentionally stopped | queued, cancelled, expired |
| `reconciliation_required` | External effect/usage is unresolved | queued after recorded resolution, failed after resolution, cancelled with unresolved effects retained |
| Terminal | completed, refused, filtered, denied, expired, cancelled, failed, budget_exhausted, verification_failed | None; a new request is a new run |

`fenced_out` is a worker-local condition, never a terminal run state. The successor owns the persisted run. A terminal result includes all confirmed and unresolved effects; cancellation does not erase them.

```ts
interface RunResult {
  runId: string;
  state: RunState;
  output?: JsonValue;
  pending?: { approvals: string[]; inputs: string[] };
  effects: EffectSummary[];
  usage: UsageSummary;
  error?: PublicError;
}
```

### 14.2 Main loop

1. Accept and deduplicate the authenticated request; persist the user message once.
2. Claim the run/conversation execution epoch and resolve pinned config.
3. Build context; reserve a model attempt; dispatch; persist final response and usage observation.
4. Branch on stop reason per §13.3.
5. For tool calls, allocate stable call IDs and persist the complete proposed batch.
6. Prepare/authorize all calls. If any requires approval/input, suspend the whole batch before any member dispatches.
7. Reserve the executable batch. Reads may run concurrently up to the configured limit. Mutations run sequentially by default.
8. Commit observed results individually. An unresolved mutation halts later mutations and enters reconciliation.
9. Append the complete tool result group in original model call order, using explicit error results where permitted.
10. Persist the checkpoint and repeat, bounded by turns, calls, cost, and active runtime.
11. Validate a candidate final output and run required verification; commit terminal state and final events.

**Repeated-call detection.** A proposed batch that repeats a previous call within the configured window receives a warning result the first time and ends the run `failed` with `LOOP_DETECTED` the second time; pollable read tools are exempt within their declared interval. Configuration, identity, and host ceilings are in §14.7; the detector is per run and recorded in audit.

Parallel mutations require tools to declare conflict keys and an explicit host grant. Calls with the same resource conflict key serialize. A batch authorization guarantee does not imply an atomic remote transaction: if the first mutation succeeds and the next fails, the first effect remains recorded. Automatic compensation is not part of the first release.

Unknown tools and invalid arguments yield sanitized error tool results without execution. Resource/policy denial may be returned to the model for recovery when host policy permits. Approval denial ends that action/run as configured and cannot be repaired by changing spelling or invoking an equivalent unapproved tool. The default is terminal `denied` for a human-denied mutation.

### 14.3 Session semantics

A conversation has one active execution at a time. A concurrent `send` returns `CONVERSATION_BUSY` unless the caller selects an explicitly supported enqueue option. The first release does not silently interleave messages. A session is an authorized local handle with a pinned agent identity; each new run locks the current compatible agent revision.

An in-flight run and its suspended approvals retain their pinned configuration. Current host revocations, disabled accounts, and resource permissions are reevaluated before dispatch/resume. A resumed action whose effective resource or required policy changed needs new preparation/approval.

### 14.4 Asking for input

The optional built-in `ask_user` tool creates `{requestId, question, responseSchema, recipientScope, expiresAt}`. It is exposed only when the host supplies an input transport or an interactive session. Answers are authenticated, schema-validated, idempotently recorded, and delivered as the corresponding tool result. Input answers do not double as action approvals. Expiry defaults to 24 hours for questions and can be shortened by the host.

### 14.5 Output verification

Agent `output` may declare `schema`, `verifier`, and `max_repairs`. Verifiers are a trusted deterministic validator, a read-only registry tool, or an explicitly configured model grader. Verification calls consume budgets and are ledgered. A model score is advisory unless the host consciously selects that standard; it is not proof of business-system state.

Business mutation verification SHOULD query the authoritative system by operation/resource ID. Evidence binds the exact action and source version. A failed verifier does not automatically retry a confirmed mutation. Repair may regenerate an answer or collect evidence; repeating an external action requires its normal recovery/authorization path.

### 14.6 Cancellation

Cancellation aborts in-flight provider/tool signals and stops dispatching new work. Cooperative abort is not proof of remote termination. The runtime waits a bounded grace interval for confirmation, checkpoints observations, and records unknown effects if needed. Child workers/processes require explicit termination and cleanup contracts; they are optional execution plugins.

### 14.7 Loop detection configuration

Location: `agents.<id>.runtime.loop_detection`; host ceilings in `HostLimits.loopDetection`. Absent configuration means the defaults below apply; `enabled: false` is permitted only when the host ceiling allows it.

```yaml
agents:
  support:
    runtime:
      loop_detection:
        enabled: true
        identical_call_window: 3        # integer 2–20; consecutive model turns inspected
        on_first: warn                  # warn | fail
        on_repeat: fail                 # fail | warn — warn is never permitted for write/destructive effects
        max_polls_per_run: 20           # ceiling for pollable tools (below)
```

| Field | Semantics |
|---|---|
| Call identity | `(tool ref, normalized inputs digest, resolved resource id)`; provider tool-call IDs do not matter |
| Window | A repeat is the same identity proposed in any of the previous `identical_call_window` model turns of this run, including the same batch |
| `on_first: warn` | The repeated call is not executed; the model receives a recorded tool result `{error: {code: "REPEATED_CALL"}}` naming the earlier call and its result reference |
| `on_repeat: fail` | A further repeat ends the run `failed` with `LOOP_DETECTED`; audit lists the repeated identity and turns |
| Effect rule | Mutations are always `fail` on repeat; a legitimately repeated mutation must present new inputs or use its declared retry contract (§16.2) |
| Polling exception | A `read` tool may declare `policy.pollable: {min_interval_ms: 2000}`; repeats separated by at least the interval are exempt from the window, counted against `max_polls_per_run`, and recorded as polls. `write`/`destructive` tools cannot be pollable |
| Host ceiling | `HostLimits.loopDetection = {minWindow, maxWindow, allowDisable, maxPollsPerRun}`; agent values outside the ceiling are configuration errors |

## 15. Budgets, limits, and fairness

### 15.1 Budget dimensions

Run budgets cover turns, model calls, provider attempts, tool calls, tool attempts, total tokens, monetary spend, active execution time, and wall-clock expiry. Context retrieval, embeddings, summarization, output repair, and verification are part of the run. Optional background memory work has a separately configured budget whose charges also count toward the subject/tenant ceilings.

Money uses integer micro-USD (`1 USD = 1,000,000 micro-USD`) in canonical state and configuration. Prices are versioned; display conversion happens at the UI boundary. Large integer counters use decimal strings where needed to preserve JSON portability.

### 15.2 Reservation protocol

The accounting authority reserves across all configured ceilings in one transaction: run, optional session allocation, subject period, and tenant period. An implementation that cannot provide this must reject that combination of limits rather than approximate it as a hard cap.

Every reservation has a unique ID, parent reservation when applicable, logical call/attempt IDs, estimate, price version, state, and scope. The loop passes its reservation handle to tool execution; the pipeline does not reserve the same dispatch twice. Reserving future child capacity is an allocation, not a second charge.

Known maximum input/output capacity and tool charges establish upper estimates. If a provider's usage is only estimated or uncapped, the system labels the monetary limit best-effort unless a host billing control supplies a real ceiling. Dispatch still requires a conservative reservation.

### 15.3 Settlement

States are `held`, `dispatched`, `settled`, `uncertain`, and `released`. Only never-dispatched reservations can be freely released. Lease loss or disconnected streams cannot release potentially spent money. Unknown usage remains held or conservatively debited until provider/account reconciliation. Each retry needs available capacity and an attempt record. Settlement is idempotent.

Human wait time does not consume active execution seconds, but `expires_at` and approval/input expiry continue to advance. Initial daily/monthly caps use UTC periods; hosts may configure a fixed billing timezone as part of the budget identity. Period changes cannot reset an in-flight reservation twice.

### 15.4 Rate and concurrency limits

Default limits are four concurrent reads per run, one mutation per run, and host-bound provider/connection limits. Backoff honors retry guidance where available, uses bounded jitter, and counts against active/wall-clock constraints according to whether execution is suspended durably. Service mode uses shared rate-limit authority when a global cap is claimed. Circuit breakers report temporary unavailability; they do not relabel business effects.

## 16. Approvals, idempotency, and recovery

### 16.1 Approval record

```ts
interface ApprovalRequest {
  id: string;
  tenantId: string;
  runId: string;
  callIds: string[];
  preparedDigests: string[];
  requesterSubjectId: string;
  allowedApproverPolicyId: string;
  view: ApprovalView;
  expiresAt: string;
  maxUses: 1;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
}
```

Approvals bind a finite ordered call set; their view shows action, destination/resource, business impact, amount where applicable, and approved artifact digests. Confidential fields are disclosed only to authorized approvers. Redaction uses a separate view and never becomes the digest input. A single approval cannot cover arbitrary later arguments.

The approval service authenticates the actor and evaluates current approver policy. Deciding twice with the same decision is idempotent; a conflicting decision returns `APPROVAL_ALREADY_DECIDED`. Decision and wake-up intent are committed together. Default expiry is one hour. Approvals are consumed once for the logical action; safe retries of the same action refer to the same consumed authorization, not a new general permission.

### 16.2 Retry safety

| `retry_safety` | Meaning | Automatic recovery |
|---|---|---|
| `never` | Duplicate/repeated execution may change business state | No automatic retry after possible dispatch |
| `repeatable` | Repeating the same operation is safe under documented semantics | Bounded retry; still record attempts and changed observations |
| `deduplicated` | Endpoint guarantees one logical effect for a stable operation key within a documented retention window | Retry using the same key and payload |

Each deduplicated tool declares key placement, scope, retention horizon, payload mismatch behavior, and reconciliation method. Natural idempotence and endpoint deduplication are not synonyms. `max_attempts` defaults to one; a larger value requires an adapter-supported retry contract. This includes credential-refresh attempts.

### 16.3 Per-call state

Calls progress through `proposed -> prepared -> waiting_approval? -> ready -> intent_committed -> dispatched -> succeeded|failed|outcome_unknown`. `dispatched` is an observation, not a guaranteed atomic boundary: a crash after intent may make dispatch itself uncertain. Recovery treats an intent without a conclusive result conservatively.

Logical call IDs are allocated and persisted before execution. Provider tool-call IDs map to them but are not the sole deduplication identity. Idempotency keys bind tenant/account, run, logical call, and payload digest; worker epochs are excluded so recovery uses the same key.

### 16.4 Recovery matrix

| Last durable evidence | Recovery action |
|---|---|
| Proposed/prepared, no intent | Reauthorize and proceed when eligible |
| Approval pending | Retain suspension; redeliver notification idempotently |
| Intent exists; no conclusive result | Mark unknown; reconcile or safely deduplicate; never assume no effect |
| Confirmed success and valid stored output | Reuse result without executing the tool |
| Confirmed effect but invalid/missing output | Query/reconcile output or request resolution; do not repeat effect |
| Confirmed failure with no effect | Retry only under configured attempt policy |
| Reconciliation confirms effect | Record evidence, settle accounting, and resume with the recovered result |
| Reconciliation cannot determine outcome | Remain `reconciliation_required`; authorized operator records a resolution |

Human approval does not close the external duplicate-effect interval. Neither a database lease nor an intent record can retract a request already sent to another system. The harness promises recorded intent, controlled retry, and explicit uncertainty; it promises one remote effect only when the endpoint's declared deduplication/reconciliation contract supports it.

### 16.5 Request idempotency

`send`/`start` idempotency keys are scoped by tenant, subject, agent, and conversation/standalone surface. The durable request record binds the normalized request digest. Reuse with identical input returns the original run; reuse with different input fails `IDEMPOTENCY_CONFLICT`. Default retention is 7 days and never shorter than the run's unresolved lifetime. External tool deduplication horizons are separate and must cover their possible recovery interval.

### 16.6 Lock-manifest approval and evaluation evidence

Both controls are **host options** in `SFieldOptions.governance` (§23.1), never agent configuration, because they govern what configuration may run.

```ts
interface GovernanceOptions {
  requireApproved?: boolean;            // default: true when deployment is "service", otherwise false
  requireEval?: {
    suite: string;                      // evaluation suite id, e.g. "evals/support"
    minPassRate: number;                // 0–1, inclusive
    maxCostDeltaRatio?: number;         // relative to the baseline, e.g. 0.2 = +20%
    maxLatencyDeltaRatio?: number;
    baseline: "current_approved" | { digest: string };
    evidenceMaxAgeSeconds?: number;     // default 2592000 (30 days)
    requireLive?: boolean;              // default false: replay evidence suffices
  };
  approvalStore?: ApprovalStore;        // default: the persistence backend
}
```

**`requireApproved`.** At `SField.create`, the compiled lock-manifest digest must have an approval record in the approval store; otherwise startup fails with `LOCK_MANIFEST_UNAPPROVED` naming the digest. On reload, an unapproved candidate is rejected and the running configuration stays. `sfield validate --require-approved` performs the same check without starting. Approval records are `{digest, approver, decidedAt, comment?, evalReportId?}`, written by `sfield lock approve <digest>` or the approval API with an authenticated actor; deciding twice with the same decision is idempotent.

**`requireEval`.** An approval is created only if an evaluation report satisfies all of: same candidate digest; `suite` matches and the suite's dataset version is the current one; `passRate ≥ minPassRate`; cost and latency deltas against the resolved baseline within the ratios when configured; `createdAt` within `evidenceMaxAgeSeconds`; `mode: live` when `requireLive`. Failures are distinct errors — `EVAL_EVIDENCE_MISSING`, `EVAL_THRESHOLD_NOT_MET`, `EVAL_EVIDENCE_EXPIRED`, `EVAL_BASELINE_UNAVAILABLE` — and block, never warn. The evaluation report record is `{id, suite, datasetVersion, candidateDigest, baselineDigest?, modelTargets, mode: "replay" | "live", passRate, verifiedSuccessRate, costDeltaRatio?, latencyDeltaRatio?, cases: ArtifactRef, createdAt, expiresAt}`; the approval record references it by `evalReportId`, and both reference the digest. A baseline of `current_approved` resolves to the most recently approved digest for the same suite; when none exists, the first approval requires `baseline: {digest}` or an explicit `--no-baseline` host action recorded in audit.

## 17. Persistence and coordination

### 17.1 Deployment capabilities

| Mode | Persistence | Execution ownership | Allowed claim |
|---|---|---|---|
| `ephemeral` | In-memory | One process | Development execution; restart loses state |
| `durable_single` | Durable transactional backend | Exclusive process ownership per deployment namespace | Restart/resume with crash recovery |
| `service` | Shared transactional coordinator and durable content | Leased workers with epochs | Multi-replica execution and coordinated budgets |

Mode is a host option, never inferred from an environment variable. `ephemeral` is an explicit opt-in. If `durable_single` cannot acquire its exclusive owner lock, startup fails. A production host requesting unsupported durability or erasure guarantees fails validation.

### 17.2 Domain persistence contract

The implementation exposes domain operations instead of requiring every host to recreate coordination from four generic byte stores. Reference packages implement these operations; hosts with existing infrastructure may implement the contract and run its conformance suite.

Stated plainly, the host's persistence burden is: provide a relational database for the reference coordinator (`@sfield/store-sqlite` for `durable_single`, `@sfield/store-postgres` for `service`), and implement or select an `artifacts` binding (`@sfield/artifacts-fs`, `@sfield/artifacts-s3`, or the host's object store). Implementing `ExecutionPersistence` itself is possible and gated by the conformance suite, but it is not the expected path; `memory` and `memoryIndex` are replaceable independently (§17.5) when a host already has a suitable store or vector system.

| Operation family | Required atomic behavior |
|---|---|
| Accept request | Deduplicate request, create run, persist initial input, enqueue wake-up |
| Claim/renew/release | Compare current ownership, expiry, and durable epoch |
| Prepare batch | Persist proposed calls and immutable preparation references |
| Authorize dispatch | Check current ownership, approval state, call state, prerequisite validity, and reserve all budget scopes |
| Record intent | Commit dispatch intent for the exact claimed call before returning dispatch permission |
| Commit result | Validate current execution ownership and call transition; attach canonical result; settle known accounting; append outbox events |
| Record late observation | Append an authenticated observation only; no stale worker state transition or second dispatch |
| Decide approval/input | Authenticate/authorize actor, commit one decision/answer, append wake-up intent |
| Suspend/finish | Commit checkpoint or terminal state plus events |
| Memory mutation/delete | Version check, scope check, tombstone/generation update, index outbox |

Checks involving external authorizers use short-lived signed/bound evidence; database atomicity does not make external policy lookups transactional. Current hard revocations maintained in the coordinator are checked during dispatch authorization.

### 17.3 Ownership protocol — Service extension

Execution ownership uses `{scopeId, ownerId, epoch, expiresAt}`. Epoch is a durable monotonically increasing integer per scope. Acquisition is linearizable using coordinator time; release clears ownership but retains the epoch. Renewal requires the same owner, epoch, and unexpired lease. Scope is a conversation for session runs or an individual standalone run. Queue/job ownership uses separate scopes.

Every authoritative runtime mutation checks current ownership in the same coordinator transaction as the mutation. A store-local maximum observed epoch is not used as a substitute for checking current authority. A takeover rejects stale writes even if the successor has never touched that record or stream.

The first service reference implementation uses one supported transactional relational coordinator. Multi-record state/approval/budget changes occur there. Object storage holds immutable content; vector systems hold derived indexes. No cross-object-store transaction is implied.

### 17.4 Checkpoint and content

A checkpoint contains run/conversation IDs, pinned configuration and plugin identities, transcript references, context packet references, per-call states/results, pending approvals/input, reservation IDs, runtime counters, and continuation metadata. It does not contain live sockets, secret values, database connections, or process stacks.

Large protected content is written immutably to an `ArtifactStore`; its digest and manifest are linked in the coordinator under current ownership. Unreferenced uploads are garbage-collected after a safe delay. A stale worker may leave an orphan immutable object, but cannot make it authoritative. Reads resolve only authorized, committed manifests and verify digests.

Canonical outputs remain JSON values or typed media/artifact references. APIs distinguish reference transport from value semantics; generic input expressions do not fetch arbitrary blobs implicitly. Consumers explicitly resolve authorized content under a size limit. Missing committed content yields `STATE_UNAVAILABLE` and stops the dependent operation.

### 17.5 Memory index consistency

Index updates use a durable outbox containing item ID, version, namespace, and deletion generation. Queries revalidate each candidate against canonical records and authorization. Stale index entries cannot resurrect or disclose deleted items. The default subject/conversation memory backend also supports exact listing without vectors, providing read-after-write behavior for explicit preferences. Semantic retrieval may be eventually consistent, with lag reported.

The memory repository is independently replaceable through `SFieldOptions.memory`. The selected persistence package supplies a compatible default when that option is absent. A custom repository MUST provide versioned get/list, idempotent create, compare-and-set update, deletion-generation checks, and an atomic mutation-plus-outbox operation. Its outbox events are deduplicated into the central audit stream; an unavailable mirror cannot lose the repository's original audit event. Core does not claim atomic transactions across separate execution and memory backends. A memory tool's logical call ID is its write idempotency key, allowing recovery after a committed memory write but before tool-result recording.

An optional `memoryIndex` implements authorized candidate search/upsert/delete against repository-issued item IDs and versions. An optional `artifacts` binding implements immutable put/get/delete by authorized committed manifest. Defaults may come from the persistence package, keeping starter wiring small while allowing existing host stores to be reused.

### 17.6 Schema evolution

Records carry independent record-schema versions plus core implementation version. Readers document their supported version range. Migrations are explicit, idempotent, and resumable; they do not run silently on every initialization. Rolling upgrades are supported only for combinations in the tested compatibility matrix. No blanket promise that all future readers or previous minor releases accept every record shape is made.

## 18. Security, privacy, and data handling

### 18.1 Data classification and routing

Classification is ordered `public < internal < confidential < restricted`. Derived content inherits at least the maximum source classification unless an authorized declassification transform issues recorded evidence. Every provider, retrieval source, artifact destination, and tool output destination has a host-defined acceptance policy. Routing checks occur before disclosure, including fallback and telemetry exports.

Redacting a string does not automatically declassify the entire object. Authorization controls access even when an item appears non-sensitive. Tool arguments that send business data to external destinations are checked for both action permission and permitted data flow.

### 18.2 Secrets

Secret resolution belongs to the bound adapter/provider, occurs when its client needs credentials, and supports invalidation/rotation. Secret values never appear in configuration hashes, tool definitions, model messages, approval views, or ordinary logs. Key-name and known-value scrubbing supplement controlled data paths; regex matching alone is not a universal secret detector.

Adapter errors are sanitized before crossing their boundary. A 401/403 does not unconditionally imply stale credentials; authorization failures are distinguished from refreshable authentication failures. Retry rules for external effects still apply.

### 18.3 Output views and streaming privacy

The system maintains separate representations for protected execution content, canonical business results, model context, browser output, and audit metadata. Each has explicit access and retention rules. Hooks identify which representation they inspect or transform.

Browser events never include raw credentials, internal stack traces, arbitrary provider raw objects, or hidden/opaque reasoning. Text streaming uses a policy-defined stateful scanner with a bounded look-behind buffer, or buffers the complete response when required patterns cannot be safely recognized incrementally. A deployment requiring strict pre-disclosure review must disable immediate text streaming. All views preserve indicators of partial output or omitted content.

### 18.4 Erasure

Erasure enumerates canonical memory, conversation content, execution checkpoints, artifacts/attachments, indexes, cassettes, and derived summaries. A durable deletion manifest tracks each destination, generation marker, state, and retry. New writes for an erased generation are rejected. Tenant-derived artifacts are rebuilt or removed when the erased contribution cannot be isolated safely.

An optional content codec encrypts protected bytes under independently destroyable content keys. Numeric vectors and structured metadata require separate encryption/access/deletion support; they are not covered merely by encrypting byte blobs. Key destruction must make retained encrypted content unrecoverable from retained key material, including backup/key recovery policy. It is not enough to delete a derived key that can be regenerated from a retained master secret.

Audit metadata retention is an explicit host policy. IDs, hashes, timestamps, and costs may be linkable and are not declared anonymous by construction. The erasure receipt reports retained categories, justification configured by the host, pending physical deletions, and inaccessible encrypted copies. This is a technical contract, not a legal compliance certification.

### 18.5 Resource exhaustion and configuration safety

Parsers enforce input bytes, nesting depth, YAML alias expansion limits, regex execution bounds, and schema/reference complexity. Config rejects prototype-pollution keys and unsupported tags. Provider streams, tool outputs, attachments, and decompressed responses have independent byte/time limits. Oversize output is stopped while being read, not after unlimited buffering.

Installed code and lock manifests are reviewed release inputs. Discovery, health checks, config validation, and prompt previews cannot secretly execute business mutations. A live preview explicitly discloses retrieval/model cost and uses the normal execution scope.

## 19. Events, audit, and diagnostics

### 19.1 Events

```ts
interface RunEvent {
  v: 1;
  id: string;
  runId: string;
  conversationId?: string;
  timestamp: string;
  type: string;
  payload: JsonObject;
}
```

Durable event types include `run_accepted`, `run_started`, `context_built`, `tool_prepared`, `tool_started`, `tool_finished`, `approval_requested`, `approval_resolved`, `input_requested`, `input_resolved`, `budget_warning`, `run_suspended`, `reconciliation_required`, and `run_finished`. Content exposed in each payload is fixed by the event schema and principal authorization.

Provisional types include `text_delta`, `generation_reset`, and optional progress notifications. They are not used to reconstruct execution state. Final output is durably available in the run snapshot.

### 19.2 Replay and backpressure

Durable events have per-run monotonic sequence IDs committed with state transitions through the outbox. Reconnecting with `after` receives subsequent retained events. If retention has removed them, return an explicit gap plus an authorized snapshot cursor. Provisional deltas may be lost on reconnect; the final snapshot replaces them.

Delivery is at least once; consumers deduplicate by event ID. Slow subscribers cannot block execution or cause unbounded memory growth. Bounded buffers drop provisional progress first, then disconnect with a resumption cursor. A conversation subscription authorizes each run and may continue after a particular run finishes; a run stream ends after its final or suspended result and does not claim that background memory jobs belong to that closed stream.

### 19.3 Audit records

Audit includes request/config identity, principal, authorization evidence, prepared invocation digest, approval decision, dispatch intent, each attempt, observed effects, result references, context selection, token/cost accounting, memory mutations, deletion receipts, and errors. Raw content is optional protected data with separate retention.

Append-only behavior is enforced through the persistence API for ordinary operations. Hash chaining, signing, and external anchoring are optional audit extensions; storing a hash alone does not establish tamper resistance against a storage administrator. Metadata and content digests use distinct identities so content erasure does not silently invalidate the defined verification scheme.

### 19.4 Error taxonomy

| Category | Representative codes | Caller behavior |
|---|---|---|
| Configuration | UNKNOWN_BINDING, DUPLICATE_TOOL, INVALID_REFERENCE, UNSUPPORTED_SCHEMA | Correct configuration; no execution |
| Validation | INVALID_INPUT, INVALID_OUTPUT, CONTEXT_LIMIT, UNSUPPORTED_MEDIA | Correct data or configuration; mutation outcome remains separate |
| Authorization | ACCESS_DENIED, APPROVAL_REQUIRED, APPROVAL_EXPIRED, POLICY_CHANGED | Obtain valid scoped authorization; no bypass retry |
| Availability | PROVIDER_UNAVAILABLE, SOURCE_TIMEOUT, STATE_UNAVAILABLE | Bounded retry when safe; required-source rules apply |
| Accounting | BUDGET_EXHAUSTED, USAGE_UNKNOWN | Stop dispatch or reconcile accounting |
| Coordination | CONVERSATION_BUSY, VERSION_CONFLICT, OWNERSHIP_LOST | Retry claim/update according to semantics; stale worker exits |
| Effect uncertainty | OUTCOME_UNKNOWN, RECONCILIATION_REQUIRED | Query remote outcome or seek authorized resolution |
| Request identity | IDEMPOTENCY_CONFLICT | Use original payload or a genuinely new request key |

Errors include a stable code, sanitized message, retry disposition, and execution IDs. Retry disposition is calculated from attempt/effect state, not only an HTTP status.

### 19.5 Developer diagnostics

The first release includes text/JSON diagnostic commands for effective config, registry, memory, context explanation, run inspection, and capability checks. A web studio is a gated extension (Appendix D). `sfield doctor` reports missing bindings and unsupported guarantees without printing secrets.

## 20. Deployment and operations

### 20.1 Initialization

`SField.create` loads installed registrations, compiles config, validates capabilities/bindings, checks persistence schema, acquires required deployment ownership, and starts plugin lifecycles. Structural failure prevents startup. Optional external service health failures may produce degraded readiness with affected agents listed; they do not trigger arbitrary live tool calls.

The host chooses when and how credentials and external connections are probed. An inspection capability may validate secret references without retrieving values; if a backend lacks that capability, startup reports that live resolution remains unchecked rather than inventing a guarantee.

### 20.2 Reload and shutdown

Reload compiles a candidate independently and switches new runs to it atomically. Existing runs remain pinned; urgent host revocations remain effective. If old executable dependencies cannot be restored, resume fails with an explicit compatibility error.

Shutdown stops admission, drains active calls up to `drainMs`, persists checkpoints/unknown outcomes, flushes durable outbox work, releases ownership, then closes owned clients. External resources injected with `ownership: host` are not closed by core. The runtime never installs signal handlers or opens ports merely on import; CLI/service wrappers wire those behaviors explicitly.

### 20.3 Service API — Service extension

| Endpoint | Semantics |
|---|---|
| `POST /runs` | Agent/message/inputs plus required Idempotency-Key; returns 202 and run ID |
| `GET /runs/{id}` | Authorized snapshot |
| `GET /runs/{id}/events` | SSE durable replay plus optional provisional deltas |
| `POST /runs/{id}/cancel` | Authorized cancellation request |
| `POST /approvals/{id}/decision` | Authenticated actor, decision, optional comment |
| `POST /inputs/{id}/answer` | Authenticated schema-bound answer |
| `GET /conversations/{id}/messages` | Authorized pagination |
| `GET /memory` | Principal-bound filtered list |
| `POST /memory/{id}/forget` | Idempotent deletion request |
| `GET /healthz`, `GET /readyz` | Liveness and dependency-aware readiness |

Request bodies cannot set authoritative tenant/roles. Authentication is host-owned middleware or an explicit configured identity integration. Browser origins, request size, CSRF protection where cookies are used, and output rendering sanitation are service-wrapper responsibilities. Tokens are not accepted in URLs by default.

### 20.4 Operational measures

Metrics include execution overhead, context-build latency, source latency/error rates, context omissions, tool latency, approval wait, uncertain effects, repair rate, memory index lag, deletion backlog, token/cost totals, provider attempts, and verified completion rate. Traces correlate by run/call/context IDs without embedding sensitive payloads in attributes.

Provisional benchmark targets are p95 under 50 ms for local tool-pipeline overhead excluding adapter I/O, p95 under 50 ms for fitting already-loaded context up to 16,000 tokens on the published reference machine, and bounded memory under concurrent streams. These are implementation targets requiring measurement, not guaranteed performance claims. End-to-end latency targets belong to each business workflow and its providers.

### 20.5 Deployment topologies

| Topology | What runs | Deployment mode |
|---|---|---|
| Embedded | The host's Node service imports `@sfield/core`; one instance per process | `durable_single` (one replica) or `service` (N replicas) |
| Service wrapper | `@sfield/server` as its own container exposing §20.3 | `service` |
| Workers | Same image, `sfield jobs run`: memory maintenance, deletion manifests, optional extraction | `service`; never in request processes |
| Control plane | Appendix D studio in control-plane mode | separate deployment; reads and proposes, never executes business actions |

Replicas in `service` mode are stateless; all authoritative state is in the coordinator, content in artifacts. Rolling deployments rely on §20.2 shutdown: active calls drain, unknown outcomes are persisted, ownership is released, and a successor resumes from the checkpoint.

## 21. Packages and CLI

### 21.1 Proposed package boundaries

| Package | Contents |
|---|---|
| `@sfield/core` | Public runtime, registry pipeline, memory/context services, interfaces, config compiler, the `anthropic` and `openai_compatible` reference provider adapters over `fetch` + SSE (§13.6), in-memory `ephemeral` persistence |
| `@sfield/http` | HTTP tool adapter |
| `@sfield/provider-*` | Optional native-API providers beyond the two reference wire formats; may use vendor SDKs |
| `@sfield/artifacts-fs`, `@sfield/artifacts-s3` | Reference `ArtifactStore` implementations |
| `@sfield/store-sqlite` | Durable single-process reference persistence |
| `@sfield/store-postgres` | Transactional shared persistence/service coordination |
| `@sfield/mcp` | Optional pinned-version MCP integration |
| `@sfield/retrieval-*` | Optional search/index integrations |
| `@sfield/cli` | Initialization, validation, inspection, evaluation, run/resume |
| `@sfield/server` | Optional authenticated HTTP/SSE host |
| `@sfield/testing` | Fixtures, fake provider/tools, conformance and failure-injection utilities |
| `@sfield/preset-local`, `@sfield/preset-memory` | Development presets (§4.3): SQLite or in-memory persistence, local artifacts, local memory, `local_files` retrieval, env secrets, CLI approvals/input, local principal; self-identifying, refused in production |

The initial implementation targets TypeScript on Node.js 22+ with ESM. A tested runtime-version matrix determines supported minors. Browser-safe event/client types may be a separate package. CommonJS builds and other language runtimes are optional later compatibility work, not assumed to be free ports.

`@sfield/core` depends on a maintained JSON Schema validator and YAML parser and nothing else (principle 13). Protocol and vendor SDKs may be used inside optional provider/integration packages, never in core. Dependency review for every package considers security exposure, maintenance, bundle size, and replacement cost.

### 21.2 Proposed commands

```text
sfield init <name> --preset local          # generated project (§4.6)
sfield init <name> --template business-agent
sfield tools add [--manifest file]           # wizard (§8.6)
sfield lock approve <digest> [--eval-report ID]   # §16.6
sfield validate --config sfield.yaml --wiring src/harness.ts
sfield config explain --agent customer_support
sfield lock build
sfield doctor
sfield tools list
sfield tools describe crm.get_customer@1.0.0
sfield tools import --source openapi --file crm.openapi.yaml --out candidates.yaml
sfield tools export --out catalog.json
sfield run --agent customer_support --message "Show the current customer tier"
sfield run inspect RUN_ID
sfield run resume RUN_ID
sfield context explain CONTEXT_ID
sfield memory list --subject SUBJECT_ID
sfield memory forget MEMORY_ID
sfield eval --suite evals/support [--candidate <digest>] [--live]   # writes an evaluation report (§16.6)
```

CLI host wiring exports `SFieldOptions` and provides the authenticated local/service principal. The CLI cannot impersonate arbitrary production roles through command flags. `init <name> --preset local` writes the generated project of §4.6; `init --template business-agent` writes the L2 starter of §24 with a `connections:` entry. Neither requests credentials beyond a model key until the user selects and binds an integration, and neither leaves placeholder objects behind. Imports emit non-executable candidates. Schema/lock changes require review before production use according to host policy.

## 22. Default values and complete configuration field reference

These defaults are materialized in the compiled configuration. Host constraints can narrow them. Invalid values or unsupported combinations are rejected.

| Path / setting | Default | Semantics |
|---|---|---|
| agent.model | `default` | Logical model must resolve when an agent runs |
| agent.tools | `[]` | No business tools unless explicitly selected |
| agent.memory.conversation | `true` | Applies to sessions; absent in standalone runs |
| agent.memory.preferences | `off` | `off` or `explicit`; starter opts in |
| agent.memory.facts | `off` | `off` or `explicit`; source-backed writes |
| agent.memory.retention_days.conversation | 30 | Content retention |
| agent.memory.retention_days.preferences | 365 | Explicit preference retention |
| agent.memory.retention_days.facts | 30 | Shortened by source validity |
| agent.context.max_input_tokens | 12000 | Total serialized input ceiling |
| agent.context.output_reserve_tokens | 2000 | Must fit model output/context limits |
| agent.context.max_tools | 24 | Maximum exposed tool definitions |
| agent.context.sources | `[]` | No configured external retrieval |
| agent.context.summarizer | absent | Logical model/transform binding required to enable |
| agent.context.priority | history, preferences, facts, retrieval, summary | Optional block priority |
| context source.max_items | 5 | Bounded retrieval |
| context source.max_tokens | 2000 | Per-source content ceiling |
| context source.timeout_ms | 3000 | Source request deadline |
| context source.required | `false` | Explicit failure behavior |
| agent.policy.preset | supervised | All business mutations approved |
| agent.budget.max_turns | 20 | Model response iterations |
| agent.budget.max_model_calls | 30 | Includes context/verification calls |
| agent.budget.max_provider_attempts | 40 | Includes retries |
| agent.budget.max_tool_calls | 50 | Logical tool calls |
| agent.budget.max_tool_attempts | 60 | Includes adapter retries |
| agent.budget.max_tokens | 200000 | Reported/estimated usage, labeled |
| agent.budget.max_cost_microusd | 1000000 | One USD; total run cost ceiling/estimate contract |
| agent.budget.max_active_seconds | 300 | Execution time, excluding human suspension |
| agent.budget.max_elapsed_seconds | 86400 | Absolute run expiry |
| agent.output.max_repairs | 1 | Bounded answer/schema/verification repair |
| agent.runtime.loop_detection | enabled, window 3, warn then fail, 20 polls | §14.7 |
| governance.requireApproved | true in `service`, else false | §16.6 |
| governance.requireEval | absent | §16.6; when set, `evidenceMaxAgeSeconds` 2592000 and replay evidence accepted |
| tool.policy.pollable | absent | Read tools only; exempts interval-spaced repeats from loop detection |
| tool.policy.timeout_ms | 10000 | Per attempt |
| tool.policy.max_attempts | 1 | Extra attempts require retry safety |
| tool.policy.retry_safety | never | No unknown-effect retry by default |
| tool.policy.max_output_bytes | 65536 | Adapter response cap |
| tool.policy.classification | internal | Binding/source classification may raise it |
| tool.policy.effect | required | No default effect for configured/discovered tools |
| tool.policy.action | tool id | Explicit for business actions (§9.1) |
| tool.resource | required for write/destructive | Read tools default to `{type: tool, id}` with a validation note (§9.1) |
| tool.outputs.select | absent | Explicit projection applied before output validation (§8.1) |
| approval expiry | 3600 seconds | Host-level setting |
| input expiry | 86400 seconds | Host-level setting |
| inline canonical result limit | 65536 bytes | Larger authorized values use artifacts |
| request idempotency retention | 7 days | Extended while unresolved |
| automatic extraction / learning | disabled | Optional explicit extension |

The first-release schema additionally permits `models.<id>.fallback`, `agents.<id>.output.schema`, `output.verifier`, `context.sources[].filters`, `context.sources[].max_age_seconds`, and plugin-owned `extensions`. All model call parameters are validated against the host `ModelBinding`; agent model parameters are a permitted `models.<id>.params` map with declared supported keys, never arbitrary provider JSON.

Configured tool fields are `version`, `description`, `adapter`, `connection`, `operation`, `inputs`, `outputs`, `resource`, `policy`, optional `deduplication`, and `extensions`. `policy` additionally allows `requires_approval` (default false; stricter preset still applies), `cost_microusd` (default 0 only for declared unmetered tools), and `prerequisite` (named host evidence check). Function tools map the same fields to TypeScript and supply a handler instead of a configured adapter operation. Composite tools and nested agents are later extensions.

## 23. Implementation contract details

### 23.1 Initialization options

```ts
interface SFieldOptions {
  config: string | ConfigDocument;
  overrides?: OverrideDocument[];
  preset?: "local" | "memory";               // development presets (§4.3); explicit fields below override preset components
  deployment?: "ephemeral" | "durable_single" | "service";   // required without a preset
  plugins?: SFieldPlugin[];
  bindings?: HostBindings;                      // optional when shorthand (§5.5) covers every reference
  tools?: ToolDefinition[];                     // defineTool results; registerTool adds more before the first run
  persistence?: ExecutionPersistence;           // required without a preset
  memory?: MemoryRepository;
  memoryIndex?: MemoryIndex;
  artifacts?: ArtifactStore;
  authorizer?: Authorizer;                      // required without a preset
  governance?: GovernanceOptions;               // §16.6
  approvals?: ApprovalTransport;
  input?: InputTransport;
  prerequisites?: Record<string, PrerequisiteCheck>;
  hooks?: RegisteredHook[];
  telemetry?: TelemetrySink;
  limits?: HostLimits;
}
```

Without a preset, `deployment`, `persistence`, and `authorizer` are required and their absence is a startup error; with a preset they are supplied and any explicit field overrides the preset's component. Presets are self-identifying and refused in production (§4.3), so production never silently inherits development defaults. `ExecutionPersistence` includes canonical conversation operations, execution/coordination domain operations, and optional default memory/artifact implementations. Explicit `memory`, `memoryIndex`, and `artifacts` options replace those defaults independently under §17.5. Required capabilities are checked at initialization. `HostLimits` provides global/period budgets, retention bounds, memory caps, event retention, approval/input timeouts, request byte limits, grants, and provider/connection concurrency. A host may provide stricter defaults than §22, reflected by config explanation.

### 23.2 HTTP operation schema

HTTP operations accept `method`, `path_template`, `path_params`, `query`, `body`, `response`, and optional `expected_status`. `path_template` is static with named placeholders; `path_params` and `query` map field names to `ValueBinding`. `body` is either one `ValueBinding` resolving a JSON value or a `fields` map whose values are `ValueBinding`; exactly one form is permitted. `response` is `json`, `text`, or `artifact`. Headers come from trusted connection/adapter configuration; model-driven header names/values are not enabled in release 1. Required idempotency headers are inserted by the deduplication contract.

### 23.3 Hooks

Hook points are `prepareTool`, `afterToolView`, `beforeMemoryWrite`, `beforeModelDispatch`, and `onEvent`. Each declares timeout, failure behavior, whether it sees protected content, and its build identity. `prepareTool` can propose input changes followed by full validation/preparation. `beforeModelDispatch` may only narrow/redact a request; any byte/token/tool change requires revalidation and re-reservation before dispatch. It cannot grant capabilities. `afterToolView` transforms the display/model view only; it cannot alter canonical effect status. Memory changes restart memory validation. Observation hooks cannot block authoritative commits through unbounded waits.

### 23.4 Deferred workflow compatibility

A later plan module must use the same execution scopes, prepared invocations, approvals, reservations, and effect records. Plan definitions are deterministic artifacts distinct from run invocations. Gates bind exact actions/artifacts; node scheduling has explicit pending/running/succeeded/failed/skipped states and typed dependency semantics. No hidden plan engine is required by the basic agent API. The current model loop records its actual trajectory; it does not claim that future adaptive actions were approved through a plan hash.

## 24. Worked business scenario: refund assistance

This scenario is the first acceptance workflow. It uses existing business systems through three registered tools: `crm.get_customer`, `orders.get`, and `refunds.request`. A required policy source supplies applicable refund rules. The business backend independently enforces refund eligibility and endpoint idempotency.

1. An authenticated support user asks to refund an order. The application starts a principal-bound session/run with a request idempotency key.
2. Context includes recent conversation, relevant confirmed preferences, and authorized refund policy passages. Customer/order records are fetched through resource-authorized read tools.
3. The agent proposes `refunds.request` with an exact order, amount in integer minor units, and currency.
4. The host prerequisite check verifies eligibility for that order/amount against current backend state. Policy prepares the exact operation and requests approval.
5. The UI displays the order, customer, amount, currency, and effect. The run is durably suspended.
6. An authorized approver decides. The decision and wake-up are committed; a worker reacquires the run and checks current authorization/evidence.
7. The tool sends the stable idempotency key. The backend returns a refund operation ID. The runtime records the effect and verifies status through an authoritative read.
8. The answer reports the actual status and operation reference, with policy citations where applicable. Memory may retain a separately requested communication preference; it does not remember the refund as a current account balance or silently change a business record.

If the worker crashes after backend acceptance, recovery queries by the idempotency/operation key or retries within the endpoint deduplication contract. If neither establishes the result, the run remains in reconciliation. It does not issue a second refund because an earlier approval exists.

The following **root configuration fragment** illustrates the mutating tool. The host `billing` binding and `refundEligibility` prerequisite are required; the endpoint's deduplication fields are a proposed integration contract to be verified by its owner.

```yaml
version: 1
tools:
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
```

`reconcile_binding` names an adapter/connection-owned reconciliation operation registered by the host, not an arbitrary agent tool or user-supplied URL. Recovery must occur before the deduplication retention horizon or obtain fresh authoritative reconciliation; expiry does not grant permission to repeat the action.

## 25. Testing and acceptance gates

### 25.1 Test layers

| Layer | Required evidence |
|---|---|
| Config | Every normative complete example compiles; fragments compile in declared fixtures; unknown keys and missing bindings fail |
| Tool contracts | Schema validation, encoding, resource checks, output caps, retry safety, canonical versus partial views |
| Memory | Principal/entity isolation, explicit-origin handling, freshness, correction/version conflicts, forget/index/job races |
| Context | Required-block preservation, token totals including tools, omission explanation, citations, ACL checks, bounded summarization |
| Runtime | Stop reasons, tool batch preflight, suspension/resume, cancellation, repair limits, request deduplication |
| Accounting | Concurrent budget scopes, attempt costs, unknown usage, no double reservations |
| Persistence | Crash transitions, exclusive ownership, epochs, approval/outbox atomicity, result reuse |
| Integration | One real business workflow with mutations and one external-loop integration |

### 25.2 Required failure-injection cases

- Crash before intent, after intent, after remote success, before result commit, before settlement, and after approval decision but before notification.
- A stale worker tries to commit to a previously untouched run stream after takeover.
- Two sessions compete for the same subject budget and two callers reuse the same request key.
- A hook changes approved arguments; authorization and approval must be invalidated.
- A tool returns a confirmed mutation with malformed output; the mutation must not be retried blindly.
- A required source fails, an optional source is empty, and unauthorized index hits appear in search candidates.
- A preference is forgotten while extraction/indexing work is queued; old jobs must not recreate it.
- A fallback provider cannot accept the selected data classification or continuation blocks.
- A secret spans streamed chunks; the configured browser-output policy must hold.

### 25.3 Evaluation design

Evaluation fixtures bind dataset version, candidate config/lock digest, model target, verifier, expected tool constraints, freshness assumptions, and whether execution is live or replay. An evaluation report is itself a durable record bound to the candidate digest; it is the evidence a lock-manifest approval consumes when `require_eval` is configured (§5.4), and the studio (Appendix D) shows it beside the proposal. Replay validates deterministic regression behavior against recorded observations; live canaries test current provider/integration behavior. Both are needed before claims of current compatibility.

Business quality measures include grounded-answer rate, correct resource selection, successful authorized action completion, unnecessary tool calls, stale-source use, clarification rate, latency, and cost. Include failed cases and adversarial resource/approval mismatches. User satisfaction alone is not proof that a retrieved fact or external effect was correct.

### 25.4 Release definition of done

Release 1 requires the adoption gate of §4.4 — a fresh-machine CI job runs `npx @sfield/cli init --preset local`, sets one model credential, reaches a successful first run in under ten minutes, connects one real tool through the wizard without editing runtime internals, and adds a second agent reusing the same integrations — plus the L2 starter, HTTP/function tools, the `anthropic` reference adapter with `openai_compatible` validated against one hosted vendor and one local runtime (§13.6), durable single-process persistence, explicit preferences, conversation history, authorized retrieval, explainable context fitting, safe approval suspension/resume, unknown-effect handling, basic CLI diagnostics, and the conformance gates for those features. A second agent and an external loop must reuse the same registered tools and memory/context APIs.

Distributed service claims, automated extraction, SQL/MCP breadth, and workflow plans are gated separately. They do not delay the basic harness unless a first customer requires them.

## 26. Delivery sequence

| Milestone | Scope | Exit criterion |
|---|---|---|
| M0 — Contracts and starter | Shared config schemas/types, example fixtures, plugin/binding contracts, public API, `@sfield/preset-local`, configuration shorthand, `sfield init --preset local` | A developer can understand the setup from one page; the §4.4 adoption gate passes; all reference config fixtures validate |
| M1 — Registry and execution records | HTTP/function tools, principal/resource authorization, prepared invocations, transactional state, attempt/effect records | Direct execution works safely with no agent loop |
| M2 — Memory and context | Conversation state, explicit preferences, retrieval bindings, source ACL/freshness, token fitting, explanations | External loop builds context and reuses memory through public APIs |
| M3 — Complete first harness | Both reference provider adapters with contract cassettes, agent loop with repeated-call detection, budgets, approvals with optional evaluation evidence, restart/resume, output validation, CLI | Refund/support workflow and failure tests pass; first release scope complete |
| M4 — Service deployment | Shared coordinator, multi-replica budgets/events/jobs, authenticated service wrapper | Takeover, cross-tenant, and concurrent-accounting conformance passes |
| M5 — Demand-led extensions | MCP/SQL integrations, additional providers, extraction, optional plans, studio | Each extension has a named use case and evidence it reduces integration work or improves outcomes |

M1–M3 form one coherent first product: a general harness with a registry, memory, and context management. They are sequencing boundaries, not a change to the product objective.

## 27. Decisions and future questions

The following decisions are fixed by this revision: a library-first TypeScript runtime; one-file agent setup; host-owned bindings; explicit plugin registration; memory/context separation; authoritative business systems; local schema validation; resource-scoped approval; durable unknown-effect handling; and optional service coordination.

Before implementation begins, record project decisions for the first provider target, first persistence backend implementation, first real business integration, deployment retention profile, and source ACL integration. These are implementation selections within the contracts, not missing authorization/recovery semantics.

Later candidates include plan execution, procedural learning, remote code environments, and a studio. They must preserve the standalone registry/memory/context APIs and may not introduce a second execution authority.

## 28. Changes from v0.9

| v0.9 emphasis or gap | v0.10 resolution |
|---|---|
| Large mandatory surface across many config files | One-file agent config with optional includes and host bindings |
| Plans as the artifact for every execution | Pinned agent configuration plus actual run trajectory; optional future plans |
| Memory and retrieval intertwined with loop internals | Independent memory, retrieval, and context contracts |
| Function-like expression subset | Typed value references; computation belongs to explicit plugins/tools |
| Model-strict schema assumed sufficient | Provider schema compilation plus mandatory local validation |
| Approval suggested as duplicate-effect protection | Scoped approval, explicit retry contract, unknown outcomes and reconciliation |
| Generic stores expected to provide implicit distributed guarantees | Domain persistence operations and explicit deployment capabilities |
| Fencing based on per-store observed epochs | Current ownership checked with authoritative state transitions |
| Redacted checkpoint treated as faithful state | Protected canonical state and separately controlled views |
| Learned constraints promoted into instructions | Preferences/reference data never grant authority |
| Broad automatic learning in initial scope | Explicit memory first; extraction and playbooks gated later |
| Dependency/line-count targets | Conformance, bounded resources, usability, and measured overhead |

## 29. Changes from v0.10

| v0.10 position | v0.11 amendment |
|---|---|
| Dependency count not a gate; SDKs allowed in provider packages; no reference provider in core | Principle 13: core depends on a JSON Schema validator and a YAML parser only; `anthropic` and `openai_compatible` reference adapters over `fetch` + SSE in core (§13.6); SDKs permitted only in optional packages |
| "Business Agent Harness"; coding, plans, learning, studio out of scope | General agent harness with business as the first acceptance domain; coding profile, plan module, procedural learning, and studio as gated extensions (Appendices A–D) that must use the main body's execution scopes, prepared invocations, reservations, and effect records |
| No repeated-call guard | §14.2 repeated-call detection with `LOOP_DETECTED` |
| Opaque-block fidelity stated; serialization stability not | §13.2/§13.6 byte-stable compiled requests, proven by contract test |
| "One provider integration" unnamed | §25.4 names the reference adapters and their validation targets |
| Evaluation methodology without enforcement | §5.4 `require_eval` blocks lock-manifest approval without a bound evaluation report |
| Persistence burden implicit | §17.2 states it: a relational database for the reference coordinator plus an `artifacts` binding |
| Deployment guidance limited to initialization and shutdown | §20.5 topologies |
| sflow-lite lineage dropped | Appendix E |

## 30. Changes from v0.11

| v0.11 position | v0.12 amendment |
|---|---|
| Starter required seven host objects before a first run | §4.5 `@sfield/dev` host bundle; twelve-line L1 starter with no external system; `devOnly` objects refused outside `ephemeral` deployment |
| Whole document normative at once | §4.5 adoption levels L1/L2/L3 naming what a developer supplies and which sections apply |
| `action` and `resource` required for every tool; outputs must enumerate every response field | §9.1 defaults scoped by effect class (`action` → tool id; `resource` required only for mutations); §8.1 explicit `outputs.select` projection |
| 30-minute onboarding target measured in trials | §4.4/§25.4 ten-minute quickstart gate in CI on every release |

## 31. Changes from v0.12

| v0.12 position | v0.13 amendment |
|---|---|
| `@sfield/dev` host bundle on `ephemeral` persistence | Development presets (§4.3): `local` on SQLite with local artifacts, memory, `local_files` retrieval, env secrets, CLI approvals, local principal; `memory` for tests; self-identifying, refused in production; every component individually overridable |
| Twelve-line starter written by hand | Generated project `sfield init <name> --preset local` (§4.6) with a working tool and knowledge source; no placeholders |
| `principal` and `idempotencyKey` always required | Preset supplies the development principal; generated request key exposed as `run.idempotencyKey` (§4.3, §7.1) |
| Bindings constructed only in host code | Configuration shorthand (§5.5) for models, connections, and sources; `${env:NAME}` allowed only in declared fields; credentials as references |
| One tool path (`defineTool`) | `sf.registerTool` for existing code and a wizard/manifest for existing APIs (§8.6) |
| Production migration as interfaces | Working examples for PostgreSQL, authenticated principals, an authorizer, and an approval transport (§4.7) |
| `loop_detection` without a location | §14.7: `agents.<id>.runtime.loop_detection` schema, identity, window, effect rule, polling exception, host ceiling |
| `require_approved` / `require_eval` without a location | §16.6: `SFieldOptions.governance` schema, approval and evaluation report records, validation errors, baseline and evidence expiry |
| `environment.id` undefined | Appendix A: `extensions.environment.<id>` configuration and the plugin-registered `environment` reference namespace |
| `stop_sequence` absent from the transition table | §13.3 row |
| Acceptance criteria as targets | §4.4 acceptance requirement measured in CI (§25.4) |

## 32. Glossary

| Term | Meaning |
|---|---|
| Agent | Configured instructions, tool set, memory/context choices, policy, and budget |
| Binding | Host-supplied connection/provider/retrieval implementation identified without exposing secrets |
| Plugin | Installed, versioned code registering supported capabilities |
| Tool | A versioned business capability with schema, resource mapping, effect, and execution contract |
| Prepared invocation | Immutable exact operation to be authorized and executed |
| Principal | Host-authenticated tenant/subject identity and attributes |
| Memory | Information retained under scope, provenance, validity, and retention rules |
| Retrieval | Authorized lookup/search of a source, with normalized evidence and citations |
| Context packet | Selected, budgeted content and tools for one model call |
| Conversation | Durable message history and related authorized content |
| Session | Local authorized handle for sending messages to a conversation |
| Run | One accepted request and its execution until completion or suspension |
| Logical call | Stable identity of one proposed tool action across attempts |
| Attempt | One transport dispatch of a model/tool operation |
| Approval | Authenticated authorization of a finite exact action set |
| Reservation | Durable capacity hold linked to an execution/attempt |
| Unknown outcome | Available evidence cannot establish whether an external effect occurred |
| Reconciliation | Establishing the remote outcome before deciding whether execution may continue |
| Coordinator | Transactional authority for run ownership, dispatch states, approvals, and budgets |
| Artifact | Immutable protected content accessed through an authorized committed reference |
| Lock manifest | Pinned effective configuration and executable dependency identities |

## 33. Specification validation note

This document defines proposed behavior and contracts. API snippets are design examples rather than a supplied SDK implementation. YAML examples are labeled complete or fragment with their required host registrations. Implementation acceptance requires generating published schemas/types, compiling the complete example fixtures, and running the behavioral conformance suite; prose and syntactically valid YAML alone do not establish a working harness.

## Appendix A. Gated extension: coding profile

**Gate:** an environment-backed execution plugin (§3.1) passes conformance for filesystem confinement, command classification, and egress control. Until then the tools below are not registrable.

- **Environment plugin.** Provides a workspace (local directory, container, or remote VM) in which filesystem and shell tools execute. Contract: `provision(principal, spec) → EnvironmentHandle`, `exec(handle, argv, limits)`, `fs(handle)`, `snapshot/restore`, `teardown`. Path confinement resolves the *parent directory* with `realpath` before comparing against the workspace root; a `path.resolve` prefix check is insufficient. Egress is an allowlist declared on the environment; the model cannot change it.
- **Configuration and the `environment` reference namespace.** Environments are plugin-owned configuration under `extensions.environment.<id>` (`type: local | docker | remote`, `image`, `workspace`, `egress: {allowed_hosts}`, `resources`, `lifecycle: run | session`); an agent binds one with `agents.<id>.extensions.environment: <id>`. The plugin registers the `environment` reference namespace (`Registrar.refNamespace`), which exposes `environment.id` and `environment.workspace` to `ValueBinding` references in tools whose adapter is environment-backed and only while resolving a call for an agent bound to an environment; any other use is a configuration error `UNKNOWN_REFERENCE_NAMESPACE`. Values are host-assigned identities, never model-supplied.
- **Tools** (all through the §9.3 pipeline; `resource.type: workspace`, `resource.id: {ref: environment.id}`): `code.read_file` (line offset/limit, default 400 lines), `code.edit_file` (`old_str` must match exactly once; `no_match`/`ambiguous_match` are returned as tool results so the model can widen the match; result includes a bounded diff hunk and the pre-image digest), `code.write_file` (refuses overwrite unless `overwrite: true`), `code.glob`, `code.grep`, `code.bash`, `git.status/diff/commit/push`.
- **Effects.** `read_file/glob/grep/status/diff` → `read`; `edit_file/write_file/commit` → `write` with `retry_safety: never` and reconciliation by comparing the file digest recorded in the intent against the current file; `push` and network-reaching commands → `destructive`. Shell commands are classified by ordered rules into an effect class (`read` for tests/builds/inspection, `write` for reversible workspace changes, `destructive` for publish/delete/network, `deny` for privilege escalation and out-of-workspace paths); compound commands take the maximum class; unclassified commands are `destructive`. Classification is recorded on the prepared invocation; it is an effect label, not a sandbox (§9.1).
- **Presets.** `code_plan` = `read_only`; `code_edit` = `bounded_auto` with a host grant for workspace writes; `code_auto` = `bounded_auto` with `output.verifier` required (`code.tests` as a registry-tool verifier, `code.diff_review` as a model grader). Pushes always require approval.
- **Sessions.** Interactive steering uses the standard session (§14.3); `ask_user` is enabled by the interactive transport. Sub-agents for exploration require Appendix B's nested execution scopes and are not part of this appendix.
- **Context.** Project instruction files, the repository tree, `git status`, and the pending diff are configured retrieval sources (§11.2) backed by read tools; tool results collapse to head/tail excerpts after four turns; the fitted view never rewrites stored history (§12.5).
- **Plans.** `code.feature` (explore → implement → tests → diff gate → commit → push) and `code.fix_ci` are Appendix B plans.

## Appendix B. Gated extension: plan module

**Gate:** conformance for node state transitions, crash between nodes, and proof that no node reaches a business system except through §9.3.

- **Plan** is a deterministic artifact: nodes of kind `tool`, `model`, `agent`, `plan`, `gate`, `map`, `wait`; typed dependencies; canonical JCS encoding; a digest that binds node definitions, tool versions, and config digest. A plan is authored in code (SDK builder with typed references), generated by a model and validated identically, or (narrowly) written in YAML with `tool` and `model` nodes only.
- **Execution.** Every `tool` node produces a prepared invocation, reservation, intent, and effect record exactly as a loop call does (§9.3–9.6, §15, §16). A `gate` node is an approval record bound to the *prepared digests* of the nodes it guards (§16.1); approving a plan digest approves the plan's structure, never a mutation — this is the answer to §23.4's concern that a trajectory cannot be approved by a hash. Node states are `pending | running | succeeded | failed | skipped | reconciliation_required`.
- **State.** Outputs are write-once; values above the inline limit are artifacts (§17.4); `map` passes references. `when` predicates use `ValueBinding` comparisons only (`eq`, `neq`, `in`); there is still no expression language.
- **Nesting.** `agent` and `plan` nodes open child execution scopes with reservations against the parent; `lineage` carries the chain; `max_depth` (default 3) and `max_nested_runs` (default 20) apply; a node already in the lineage is a cycle and fails before any reservation.
- **Failure.** Per-node `on_failure: fail | skip | fallback`; declared `compensate` actions run in reverse topological order on abort, each through the pipeline with its own authorization; undeclared effects are listed in the abort record as orphaned. Compensation never runs after ownership loss.
- **Approval evidence.** Plan digests are approved like lock manifests (§5.4) and may require evaluation evidence (§25.3).

## Appendix C. Gated extension: procedural learning

**Gate:** evaluation evidence (§25.3) of improved verified completion on repeated intents without any change to policy, tools, or grants.

- **Playbooks** are mined from audit records, never from model self-report: runs with confirmed effects or verified completion and no negative feedback, grouped by an intent label and agent, yielding a tool-sequence prefix, guidance summarized from those runs with identifiers stripped, and success statistics.
- **Lifecycle.** `candidate` → `shadow` (retrieved and logged, not shown) → `active` after N further successes or explicit admin promotion → `retired` when success drops below a threshold or on repeated negative feedback.
- **Authority.** Playbooks are `reference_data` context blocks (§12.7). They never become instructions, never grant tools, and never change effect classes. A recurring playbook that should be mandatory is promoted into host policy by a human, not by the miner.
- **Scope and privacy.** Subject-scoped by default; tenant scope requires explicit opt-in and the same sensitivity filtering as memory extraction; deletion generation markers (§10.6) apply to playbooks derived from erased runs, and a playbook whose sources are all erased is retired.
- **Feedback.** `sf.feedback.record({runId, signal, text})` is an audit record linked to the run and to the context blocks in effect; corrections are memory candidates under §10.3 rules.

## Appendix D. Gated extension: studio

**Gate:** every write path uses the public API (§7.2); the studio has no persistence access of its own.

- **Packaging.** `@sfield/studio` is separate; nothing starts on import of `@sfield/core`; `sfield studio` or `startStudio(sf, …)` starts it explicitly. Dev mode binds loopback with a one-time token and refuses `NODE_ENV=production` unless explicitly allowed; control-plane mode is a deliberate deployment behind host OIDC with `viewer | editor | approver | admin` roles.
- **Features.** Config editor with schema-generated forms and provenance map (§5.2); registry browser and non-executing tool preview; context packet explanation (§12.6); run inspector over audit records; approvals and input inbox; memory browser bound to `sf.memory.for(principal)`; policy simulator (`effectiveTools` and grants for a chosen principal); `doctor` output.
- **Change control.** In control-plane mode, config edits become proposals: diff, resulting lock-manifest digest, evaluation report, approval. Runtimes with `require_approved` load only approved digests. The studio is the UI for §5.4 and §25.3; it adds no authority.

## Appendix E. Lineage: sflow-lite

The sflow-lite loop is the seed of the §14 runtime. What carries over and what changes:

| sflow-lite | v0.11 |
|---|---|
| Append-only message array; assistant content including provider-owned blocks pushed back verbatim | §12.5 opaque-block fidelity; §13.3 `continue` handling |
| Strict tools, byte-stable tool order, cache breakpoint on the system prompt | §13.2 alias mapping plus the serialization-stability rule (§13.6) |
| All parallel tool results returned in one message; errors returned as error results | §13.2 logical result batch; §14.2 step 9 |
| `completed` means verified when a verifier is set; bounded repairs | §14.5 with `max_repairs` |
| SSE ring buffer with `Last-Event-ID` replay | §19.2 durable events plus provisional deltas |
| `POST /runs` → observe → fetch → cancel | §20.3 service API |
| Local handler map and `/bin/sh -c` shell | Function tools (§8.3) and the Appendix A environment plugin |
| In-memory run state | `durable_single` persistence (§17.1) |
| Anthropic SDK types | `anthropic` reference adapter over `fetch` (§13.6) |
