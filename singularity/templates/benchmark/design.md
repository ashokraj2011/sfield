# {{work.id}} — Benchmark Design

## Summary

TODO: Summarize the selected design, consequential tradeoffs, affected boundaries, risks, and validation approach.

## Context and constraints

TODO: Relate the approved intake to current repository behavior and constraints.

## Design and interfaces

TODO: Define components, contracts, data flow, error behavior, security, and observability.

## Alternatives and decisions

TODO: Record considered alternatives and why this design was selected.

## Risks and rollback

TODO: Define compatibility, migration, rollout, failure containment, and rollback.

## Planned implementation evidence

Add exactly one row for every authoritative clause approved in Benchmark Intake. Use its fully qualified
clause ID. List only exact repository-relative source and test paths in backticks; do
not use directories, globs, module names, or prose in path cells. For a genuinely non-testable
clause, write `not-applicable:` followed by a concrete reviewed explanation under `Planned tests`;
never use that disposition to defer a test or replace a path that has not yet been identified.

For new/modified delivery, `Expected paths` contains product source only and `Planned tests` contains
test files only; never repeat a test file in both columns. A test-only obligation uses fulfillment
`test-only`, `Expected paths` = `-`, and its exact tests under `Planned tests`.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (behaviour already at the listed paths), removed, test-only (tests are the whole delivery; Expected paths is -), document, configuration, or evidence (retained files under this Story's evidence/ directory). Do not put screenshots in Planned tests or product-source rows. An evidence AC needs a primary visual/inspection Verification contract; file presence is not a visual pass. Observable result states what is observed. Multi-code-step plans add Steps to allocate each row. -->
