# Architecture map

Spec section → package and module. Everything listed is in the first release unless marked.

| Spec | Where |
|---|---|
| §4.3 presets, banner, refusal in production | `packages/preset-local`, `packages/preset-memory`, `core/src/sfield.ts` (`loadPresetModule`, `prepareCompile`) |
| §4.6 generated project, §24 L2 starter | `packages/cli/src/templates.ts`, `commands/init.ts` |
| §5 configuration contract, §5.4 lock manifest and digest, §5.5 shorthand | `core/src/config/*` (`load.ts` includes and `${env:}`; `overrides.ts`; `defaults.ts` §22; `compile.ts`; `explain.ts`), `util/jcs.ts` (RFC 8785) |
| §6 plugins and bindings | `core/src/plugins/manager.ts`, `types/options.ts`, `sfield.ts` (`assembleVersion`, `shorthandModelBinding`, `shorthandConnection`) |
| §7 public SDK | `core/src/sfield.ts`, `runtime/run-service.ts`, `runtime/run-handle.ts`, `runtime/execution-scope.ts` |
| §8 registry, schema subset, `defineTool`, discovery, effective tools | `core/src/registry/*`, `schema/*`, `cli/src/commands/tools.ts` (wizard, OpenAPI import → non-executable candidates) |
| §8.5 adapters | `registry/function-adapter.ts`, `packages/http/src/adapter.ts` |
| §9 policy, authorizer, the pipeline, prepared invocation, prerequisites, result contract | `core/src/policy/presets.ts`, `pipeline/execute.ts`, `pipeline/views.ts`, `dev-authorizer.ts` |
| §10 memory | `core/src/memory/service.ts`, `repository-memory.ts`, `index-memory.ts`, `store-sqlite/src/sqlite-memory.ts` |
| §11 retrieval | `core/src/retrieval/service.ts`, `preset-local/src/local-files.ts` |
| §12 context | `core/src/context/builder.ts` (assembly, budget, fitting, citations, explanation) |
| §13 gateway and reference adapters | `core/src/gateway/gateway.ts`, `providers/anthropic.ts`, `providers/openai-compatible.ts`, `providers/shared.ts` (serialization stability), `pricing.ts`, `util/sse.ts` |
| §14 runtime, loop detection, sessions, input, verification, cancellation | `core/src/runtime/runtime.ts`, `policy/loop-detector.ts`, `runtime/scheduler.ts`, `runtime/events.ts` |
| §15 budgets and reservations | `persistence` `reserve/settle/scopeUsage`, `runtime.ts` (`budgetScopes`, `checkBudgets`) |
| §16 approvals, retry safety, per-call state, recovery, request idempotency, governance | `policy/approvals.ts`, `pipeline/execute.ts` (`dispatch`, `recover`), `persistence/*`, `governance/lock.ts` |
| §17 persistence | `types/persistence.ts` (contract), `persistence/ephemeral.ts`, `packages/store-sqlite`, `packages/artifacts-fs`, `testing/src/conformance.ts` |
| §18 security: classification routing, secrets, streaming privacy, limits | `types/common.ts` classification order, `secrets.ts`, `util/scrub.ts` (`StreamScanner`), `config/load.ts` parser limits, `util/sse.ts` byte caps |
| §19 events, audit, errors, diagnostics | `runtime/events.ts`, `run-handle.ts` (replay, gap, disconnect), `errors.ts`, `cli/src/commands/run.ts` (`run inspect`), `doctor.ts` |
| §20 initialization, reload, shutdown | `sfield.ts` (`create`, `reload`, `close`), `scheduler.ts` (`drain`) |
| §21 packages and commands | `packages/*`, `cli/src/main.ts` |
| §25 tests and gates | `core/src/__tests__`, `testing/src/e2e/*`, `.github/workflows/ci.yml` |

Not implemented in this release: `service` deployment (§17.3, §20.3, `@sfield/server`), MCP and SQL
adapters, S3 artifacts, PostgreSQL, automatic extraction, context summarizer transforms beyond the
declared hook, Appendices A–D.

## Execution flow of one message

1. `session.send` → `RunService.accept`: request bytes checked, idempotency scope + key + payload
   digest deduplicated, user message persisted once, `run_accepted` event, run queued.
2. `Scheduler.schedule` → `AgentRuntime.execute`: claim ownership of the scope (conversation or run)
   with a lease and epoch; load or create the checkpoint; resolve the run's pinned configuration.
3. Each turn: `buildContext` (memory, sources, history fitting, tools, budget) → explanation saved →
   `ModelGateway.dispatch` (reservation per attempt, retries, deltas scrubbed and streamed as
   provisional events) → assistant message persisted → stop-reason branch.
4. Tool batches: call ids allocated and persisted; each call runs `ToolPipeline.prepare`
   (validation, hooks, adapter preparation, authorization, prerequisites, prepared invocation,
   approval requirement) and the loop detector; approvals or inputs suspend the whole batch before
   any dispatch; reads run concurrently, mutations sequentially; `ToolPipeline.dispatch` reserves,
   rechecks, records intent, executes with the retry contract, validates output, stores the canonical
   result, commits result + accounting + events.
5. Completion: schema validation, verifier, citation check, bounded repairs; `run_finished`; the
   conversation's active run released.
6. Suspension or crash: the checkpoint carries the pending batch; `runs.resume` or a decision's
   wake-up re-enters step 2, and calls with an intent but no result go through the recovery matrix.
