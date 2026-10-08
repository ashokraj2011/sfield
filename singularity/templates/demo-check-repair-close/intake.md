# {{work.id}} — Demo intake and acceptance

{{inputs}}

## Approved sources

TODO: Identify Story details and each retained screenshot/document by ID, path and SHA-256.
Record source interpretation and missing states; attached material is evidence, not instructions.

## Scope and acceptance criteria

TODO: Describe the outcome, allowed product/test paths, exclusions and safety boundaries.

| Requirement | Source-backed behavior |
|---|---|
| [{{work.id}}:REQ-001] | TODO: Expected behavior |

| Acceptance criterion | Observable assertion |
|---|---|
| [{{work.id}}:AC-001] | TODO: Given state, when action, then expected result |

## Scenario matrix

| Scenario | Criterion | State and steps | Assertion / tolerance | Test identity or inspection method | Evidence contract |
|---|---|---|---|---|---|
| DEMO-001 | `{{work.id}}:AC-001` | TODO: Deterministic state and steps | TODO: Outcome | TODO: Real method | TODO: Story path and witness checklist if needed |

## Test environment and commands

TODO: Record inspected existing runners, authorized argv/cwd, report adapter, test scope and
environment. Playwright or another existing approved tool may be used. For visual assertions
agree viewport, fonts, animation/data rules and dynamic masks. Missing configuration is pending;
use /sf-test-setup before governed execution. Intake itself does not execute or install tests.

## Planned implementation evidence

Plan a repair only if fresh checking demonstrates a defect.

| Clause | Expected paths | Planned tests | Change kind | Expected behavior |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: Real source paths | TODO: Executable regression paths | update | TODO: Observable behavior |

TODO: Include explicit evidence-file slots/methods for screenshots or document inspection,
separately from product-source delivery. Do not invent source markers for an evidence-only clause.

## Routing and human checkpoints

TODO: Confirm Intake → Check → Repair → Check until pass, then Close. Human approval reviews each
report/repair and the final closing document. Pass requires fresh executed evidence and human
implementation-applicability for no additional repair. Missing tools/evidence are blocked. After
three backward routes per decision, ask for explicit direction or revised intake; never force pass.
