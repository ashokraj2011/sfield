# {{work.id}} — Quick fix scope and plan

This short checkpoint states what the fix must do and where it lands before any code changes.
One reviewer signs it off; Implement then has to meet exactly these claims.

## Problem and fix

TODO: Describe the defect or small change and the intended fix in one or two sentences.

## Acceptance criteria

Give every outcome a stable, fully qualified ID. Replace the example; do not approve this draft
while placeholders remain.

| Clause | Observable outcome |
|---|---|
| [{{work.id}}:AC-001] | TODO: State one observable, testable outcome of the fix. |

## Planned implementation evidence

One row for each clause above, with exact repository-relative source and executable-test paths
in backticks. If a clause truly cannot be tested, write `not-applicable:` and a specific reason.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: `src/example.js` | TODO: `test/example.test.js` | new | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (behaviour already at the listed paths), removed, test-only (tests are the whole delivery; Expected paths is -), document, configuration, or evidence (retained files under this Story's evidence/ directory). Do not put screenshots in Planned tests or product-source rows. An evidence AC needs a primary visual/inspection Verification contract; file presence is not a visual pass. Observable result states what is observed. Multi-code-step plans add Steps to allocate each row. -->

## Out of scope

TODO: State what this fix deliberately leaves unchanged.
