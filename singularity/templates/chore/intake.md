# {{work.id}} — Chore scope and plan

This checkpoint states the maintenance outcome and the changes that deliver it before any file
changes. A chore may change dependencies, build and CI configuration, repository metadata and
documentation. A change to application source, tests or migrations needs a workflow with a code
step, such as quick-fix.

## Objective

TODO: Describe the maintenance outcome.

## Maintenance outcomes

Give every outcome a stable, fully qualified ID. Replace the example; do not approve this draft
while placeholders remain.

| Clause | Observable outcome |
|---|---|
| [{{work.id}}:AC-001] | TODO: State one observable outcome, such as the lockfile pinning a version or the build passing. |

## Supporting files

The plan: one bullet for each file this chore changes, with an exact backticked repository path and
why it changes, for example - `package-lock.json` — pins the patched release. Dependency locks,
build and CI configuration, repository metadata and documentation qualify; the class comes from the
path.

- `package-lock.json` — TODO: why this file changes.

## Validation

TODO: Name the commands or checks that show the outcome holds.

## Risk and rollback

TODO: State the primary operational risk and the rollback or containment approach.
