# Getting started

The specification defines three adoption levels (§4.5). Each one adds what a developer supplies.

## L1 — local: one agent, one function tool, one knowledge directory

```bash
npx @sfield/cli init support-agent --preset local
cd support-agent
npm install
cp .env.example .env      # set ANTHROPIC_API_KEY, or switch models.default to openai_compatible
npm start "Where is order A-1001?"
```

What you get (all of it works, nothing is a placeholder):

| File | Purpose |
|---|---|
| `sfield.yaml` | one model (provider shorthand), one `local_files` source, one agent |
| `instructions.md` | the agent's instructions, referenced by `instructions_file` |
| `tools.ts` | `orders.get`, a function tool over sample data |
| `app.ts` | the minimal application: create, open a session, send, stream, print the result |
| `knowledge/refund-policy.md` | sample knowledge read by the `local_files` retrieval type |

The `local` preset assembles SQLite persistence under `./.sfield/`, local artifacts, memory,
`local_files` retrieval, environment-variable secrets, CLI approvals in the terminal, and the local
development principal (`tenant: local`, `subject: developer`). It prints a banner on every start and
refuses to load under `NODE_ENV=production`.

Useful commands while you iterate:

```bash
sfield validate                 # file/config path, stable code, explanation, suggestion for every error
sfield config explain --agent support
sfield doctor                   # which preset components are still in use, health, lock status
sfield run --agent support --message "What is the refund policy?"
sfield run inspect RUN_ID       # calls, attempts, events, audit, context ids
sfield context explain CTX_ID   # what was included, omitted, and why
sfield memory list
```

### Using a local OpenAI-compatible runtime instead of a hosted key

```yaml
models:
  default:
    provider: openai_compatible
    model: gemma4
    base_url: http://localhost:11434/v1
    credential: {env: OPENAI_API_KEY}     # any value for Ollama
```

## L2 — one real integration

```bash
npx @sfield/cli init business-agent --template business-agent
cd business-agent && npm install && cp .env.example .env
npm run backend    # a local mock billing API; swap BILLING_BASE_URL/BILLING_TOKEN for the real one
npm start
```

The template adds a `connections:` entry, two HTTP tools (`crm.get_customer` with `outputs.select`,
`refunds.request` with a deduplication contract and a prerequisite), a host `harness.ts` supplying
the `refundEligibility` prerequisite and the `refund_status_by_key` reconciliation binding, and the
refund workflow of §24. The destructive refund tool always suspends for approval; in the terminal
you are asked to approve it.

To add another existing API endpoint:

```bash
sfield tools add                          # interactive wizard
sfield tools add --manifest orders.yaml   # non-interactive
sfield tools import --source openapi --file crm.openapi.yaml --out candidates.yaml   # review, then add
```

Or register existing application code on the instance before the first run:

```ts
sf.registerTool({ id: "orders.get", version: "1.0.0", description: "...", inputs, outputs,
  authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } },
  handler: ({ order_id }, ctx) => orderService.get(ctx.principal, order_id, { signal: ctx.signal }) });
```

## L3 — production

Production has no preset. Replace components one at a time; agents and tools do not change.

```ts
import { SField } from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";     // or a PostgreSQL implementation of ExecutionPersistence
import { fsArtifacts } from "@sfield/artifacts-fs";           // or an object-store ArtifactStore
import { httpPlugin } from "@sfield/http";

const sf = await SField.create({
  config: "./sfield.yaml", tools, plugins: [httpPlugin()],
  deployment: "durable_single",
  persistence: sqlitePersistence({ path: "/var/lib/app/sfield.db" }),
  artifacts: fsArtifacts({ root: "/var/lib/app/artifacts" }),
  authorizer,                 // answers action-on-resource questions with expiring evidence (§9.2)
  approvals: transport,       // notifies your UI; decisions arrive through sf.approvals.decide
  input: inputTransport,      // optional: enables ask_user
  limits: { grants: { interactionTools: ["ask_user", "memory.remember", "memory.forget"] } },
  governance: { requireApproved: true },
});

app.post("/chat", auth, async (req, res) => {
  const principal = { tenantId: req.user.orgId, subjectId: req.user.id, roles: req.user.roles, attributes: {} };
  const session = await sf.sessions.open({ agent: "support", principal, conversationId: req.body.conversationId });
  const run = await session.send({ message: { text: req.body.text }, idempotencyKey: req.headers["idempotency-key"] as string });
  for await (const ev of run.events()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.end();
});
```

`governance.requireApproved` (default `true` in `service` deployments) makes startup fail with
`LOCK_MANIFEST_UNAPPROVED` until the compiled digest has an approval record:

```bash
sfield lock build
sfield eval --suite evals/support           # optional evidence; required when governance.requireEval is set
sfield lock approve sha256:… --eval-report eval_…
```

`sfield doctor` shows which components still come from a development preset, so a partial
migration is visible rather than silent.
