<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

What will be tested, and what passing means. Written from the approved requirements, so that
coverage is an allocation rather than an invention — a test that proves nothing anybody asked for is
work without a requirement behind it.

## Coverage of requirements

Every Must requirement appears here at least once. A requirement with no test is a requirement
nobody will notice breaking.

| Requirement | Acceptance criteria | Tests | Covered |
|---|---|---|---|
| REQ-1 | AC-1 | T-1 | yes / no |

## Test catalog

| ID | Tests | Level | Preconditions | Steps | Expected |
|---|---|---|---|---|---|
| T-1 | AC-1 | unit / integration / end-to-end / manual | | | |

## Negative and edge cases

The cases that are skipped when a catalog is written from the happy path: refusal, timeout, partial
failure, permission denied, concurrent change, empty and maximum inputs.

| ID | Case | Expected behaviour | Requirement |
|---|---|---|---|
| T-N1 | | | |

## Not tested

What is deliberately out of test scope, and the risk that carries. Every catalog has this section;
most leave it implicit.

| Area | Why not tested | Risk accepted by |
|---|---|---|

## Environments and data

Where each level runs and what data it needs. A test that cannot be run where it is needed is not
coverage.

| Level | Environment | Data | Owned by |
|---|---|---|---|

## Definition of done for testing

What must be true before this initiative's testing is considered complete.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
