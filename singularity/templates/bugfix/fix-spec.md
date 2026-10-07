# {{work.id}} — Fix Specification

## Planned implementation evidence

Add exactly one row for every authoritative clause. Use a fully qualified clause ID. List only exact
repository-relative source and test paths in backticks; do not use directories, globs, module names,
or prose in path cells. For a genuinely non-testable clause, write `not-applicable:` followed by
your concrete reviewed explanation under `Planned tests`; never defer a regression test or replace an unknown path.

For new/modified delivery, `Expected paths` contains product source only and `Planned tests` contains
test files only; never repeat a test file in both columns. A test-only obligation uses fulfillment
`test-only`, `Expected paths` = `-`, and its exact tests under `Planned tests`.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:BEH-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative regression test paths | modified | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (behaviour already at the listed paths), removed, test-only (tests are the whole delivery; Expected paths is -), document, configuration, or evidence (retained files under this Story's evidence/ directory). Do not put screenshots in Planned tests or product-source rows. An evidence AC needs a primary visual/inspection Verification contract; file presence is not a visual pass. Observable result states what is observed. Multi-code-step plans add Steps to allocate each row. -->

## Exact change

The fix MUST change the observed failure into the expected behavior TODO without altering TODO. [{{work.id}}:BEH-001]

## Regression and negative tests

TODO: Explain the regression and negative cases recorded as exact paths in the planned implementation
evidence table. Bind every test to its corresponding fully qualified REQ/BEH/IFC/AC/CON clause ID.
