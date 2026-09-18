# Singularity Field (`sfield`)

An embeddable, vendor-neutral runtime for agents, built to the
[Singularity Field specification v0.13](docs/spec/sfield-spec-v0.13.md).

It connects models to approved capabilities through **one tool pipeline**, retains scoped
information **with provenance**, assembles **explainable context** for each model call, and keeps
**honest execution records** — including outcomes it cannot establish.

```
npx @sfield/cli init support-agent --preset local
cd support-agent && npm install
cp .env.example .env        # set ANTHROPIC_API_KEY (or point at an openai_compatible runtime)
npm start                    # "What is the refund policy?"
```

## What is in the box

| Package | Contents |
|---|---|
| `@sfield/core` | Config compiler (includes, overrides, `${env:}` in declared fields only, defaults, lock manifest, JCS digests), JSON Schema subset validator, tool registry and the §9.3 pipeline, memory / retrieval / context services, model gateway with the `anthropic` and `openai_compatible` adapters over `fetch` + SSE, the agent runtime (durable loop, approvals and input suspension, loop detection, budgets, output verification, cancellation, fallback, reload with pinned versions), external execution scopes, `ephemeral` persistence |
| `@sfield/http` | HTTP tool adapter: fixed connection identities, encoded path params, allow-listed hosts checked against resolved addresses, no redirects, byte caps while streaming, deduplication-key insertion, effect knowledge from status |
| `@sfield/store-sqlite` | `durable_single` persistence over `node:sqlite` with exclusive ownership per namespace |
| `@sfield/artifacts-fs` | Filesystem artifact store with committed manifests and orphan GC |
| `@sfield/preset-local` / `@sfield/preset-memory` | Development presets (§4.3): SQLite or in-memory persistence, local artifacts and memory, `local_files` retrieval, env secrets, CLI approvals/input, the local principal; self-identifying, refused in production |
| `@sfield/cli` | `sfield init | validate | config explain | lock build/approve/status | doctor | tools list/describe/add/import/export | run | run inspect/resume | context explain | memory list/forget | approvals | inputs | eval` |
| `@sfield/testing` | Scripted fake provider, harness, SSE cassette helpers, persistence and serialization conformance suites |

`@sfield/core` depends on a JSON Schema validator (`ajv`) and a YAML parser (`yaml`) and nothing
else. Provider adapters are plain `fetch` + SSE.

## Embedding

```ts
import { SField, defineTool } from "@sfield/core";

const sf = await SField.create({ preset: "local", config: "./sfield.yaml", tools });
const session = await sf.sessions.open({ agent: "support" });
const run = await session.send({ message: { text: "Where is order A-1001?" } });
for await (const ev of run.events()) if (ev.type === "text_delta") process.stdout.write(String(ev.payload.text));
console.log(await run.result());
```

Production replaces preset components one at a time (§4.7): `persistence`, an authenticated
`principal` per request, an `authorizer`, and an `approvals` transport. Agents and tools do not
change. `sfield doctor` lists which preset components are still in use.

## Development

```bash
pnpm install
pnpm run build          # tsc -b over all packages
pnpm test               # node --test over the compiled test files
```

Requires Node.js 22.13+ (`node:sqlite`). Generated projects run their TypeScript directly with
`--experimental-strip-types`; the CLI re-executes itself with that flag so `tools.ts` loads.

## Verified so far

- 113 automated tests across all packages (`pnpm test`): config compiler, schema subset, pipeline,
  memory, retrieval, context fitting, both provider adapters against recorded cassettes, gateway
  retries, runtime end to end (approvals, input, loop detection, idempotency, repairs, budgets,
  fallback, reload with pinned runs, crash recovery), persistence conformance for the in-memory and
  SQLite stores, the HTTP adapter against a real local server, the generated projects.
- Live, through the real `sfield` CLI and the `local` preset on a local Ollama runtime (`gemma4`):
  the L1 starter answered an order question with a tool call and cited policy passages; the
  business-agent starter ran the §24 refund flow — two concurrent reads (one over HTTP with bearer
  auth), the eligibility prerequisite, a parked destructive approval, `sfield approvals decide`,
  in-process resumption, one deduplicated refund dispatch, confirmed effect.
- The `anthropic` adapter is verified against recorded cassettes only; no hosted credential was
  available in this environment.

## Status against the specification

Implemented: §§4–16 for a single process (`ephemeral` and `durable_single`), both reference provider
adapters with contract cassettes, the local and memory presets, the generated projects, the CLI,
and the conformance suites. Not implemented (gated or later milestones): the `service` deployment
mode and `@sfield/server`, MCP and SQL adapters, S3 artifacts, PostgreSQL, automatic memory
extraction, and Appendices A–D.
