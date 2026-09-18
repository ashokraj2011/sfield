# Singularity Field (`sfield`)

An embeddable, vendor-neutral runtime for agents, built to the
[Singularity Field specification v0.13](docs/spec/sfield-spec-v0.13.md).

It connects models to approved capabilities through one tool pipeline, retains scoped
information with provenance, assembles explainable context for each model call, and keeps
honest execution records — including unknown outcomes.

## Packages

| Package | Contents |
|---|---|
| `@sfield/core` | Config compiler, tool registry and pipeline, memory/retrieval/context services, model gateway with the `anthropic` and `openai_compatible` adapters over `fetch` + SSE, agent runtime, `ephemeral` persistence |
| `@sfield/http` | HTTP tool adapter |
| `@sfield/store-sqlite` | `durable_single` persistence over `node:sqlite` |
| `@sfield/artifacts-fs` | Filesystem artifact store |
| `@sfield/preset-local`, `@sfield/preset-memory` | Development presets |
| `@sfield/cli` | `sfield` command |
| `@sfield/testing` | Fake provider, harness, cassette helpers, conformance suites |

`@sfield/core` depends on a JSON Schema validator (ajv) and a YAML parser (yaml) only.

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

Requires Node.js 22.13+ (for `node:sqlite`).
