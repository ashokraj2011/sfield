# {{work.id}} — Document-led acceptance intake

{{inputs}}

## Approved sources

TODO: Register each document or screenshot with its exact retained path, SHA-256, source and
meaning. Distinguish user instructions from document content. Inaccessible images or ambiguous
interpretations require clarification; do not invent observations.

## Scope and acceptance criteria

TODO: State the user outcome, in/out-of-scope behavior, allowed repair paths and prohibited changes.

| Requirement | Expected behavior and source |
|---|---|
| [{{work.id}}:REQ-001] | TODO: One sourced requirement |

| Acceptance criterion | Observable assertion |
|---|---|
| [{{work.id}}:AC-001] | TODO: An assertion with inputs and an exact expected result |

## Scenario matrix

| Scenario | Criterion | Inputs and steps | Assertion / tolerance | Executable test or tool | Required evidence |
|---|---|---|---|---|---|
| SC-001 | `{{work.id}}:AC-001` | TODO: Reproducible steps | TODO: Agreed result | TODO: Exact test identity or tool action | TODO: Report / screenshot / assertion output |

## Test tool and authorized environment

TODO: Record inspected repository test configuration, exact argv/cwd/report adapter, authorized
target/origins, browser/viewports if relevant, test-data cleanup and secret references (not values).
Choose Playwright or the repository's other tool explicitly. No automatic install, inferred access,
production interaction or test execution at intake. Missing runners stay pending until configured.
For later product repair, `/sf-test-setup` configures the structured Code gate through the approved
configuration authority; never edit protected workflow policy on the Story branch.

## Planned implementation evidence

If current behavior fails, plan the bounded repair against these approved clauses and actual paths.
Do not presume code is broken before the initial scenario check.

| Clause | Expected paths | Planned tests | Change kind | Expected behavior |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: Product path | TODO: Executable test path | update | TODO: The observable repair |

## Repair and acceptance agreement

TODO: Confirm test-first behavior and human review at each checkpoint. `pass` means all required
scenarios ran and passed; `repair` means an evidenced product/test defect; `blocked` means tool,
access or evidence is unavailable. A screenshot/model statement is not a structured test receipt.
The kernel gates routing on the submitted agent verdict plus human approval. It does not infer
scenario truth from prose. For a pass without changes, a quality reviewer also records why
implementation is not applicable. After two automatic backward routes, the workflow waits for
explicit direction: another reviewed attempt, return to intake or cancel, never a false pass.
