# {{work.id}} — Regression impact analysis

## Compared revisions

{{inputs}}

Record the exact pinned remote base commit, current Story commit/tree, comparison command, and
whether uncommitted bytes were included. Never call a status-only hash a content comparison.

## Changed-code evidence

| Changed path or symbol | Evidence | Runtime responsibility | Existing tests |
|---|---|---|---|
| Record exact paths/functions/routes | file, line, diff, or command | What the code actually owns | Exact test/config references |

Inspect project and framework configuration before proposing a runner, test root, fixture, Page
Object Model, or build command. Distinguish direct changes from unchanged dependencies.

## Regression footprint

| Surface / journey | Why it may be affected | Risk | Evidence strength |
|---|---|---|---|
| Observed route, component, API, or state | Trace from changed code to behavior | low/medium/high | observed/inferred/unknown |

Include data, authentication, accessibility, responsive, network, and error-state consequences when
the changed code reaches them. Label every inference and say what UI observation would confirm it.

## Proposed scenarios

Map each approved `[POC:AC-nnn]` item and each material changed-code risk to an executable scenario
or an explicit reason it is out of scope. Prioritize a small demonstration path plus meaningful
regression coverage; do not claim full application coverage from a partial diff.

## Risks and unknowns

Record missing source context, unavailable routes, feature flags, test-data constraints, unstable
dependencies, and environment differences. State which unknowns block UI exploration or test
generation and route them to clarification rather than inventing an answer.
