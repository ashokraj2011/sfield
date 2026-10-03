# {{work.id}} — Fix Specification

## Planned implementation evidence

Add exactly one row for every authoritative clause. Use a fully qualified clause ID. List only exact
repository-relative source and test paths in backticks; do not use directories, globs, module names,
or prose in path cells. For a genuinely non-testable clause, write `not-applicable:` followed by
your concrete reviewed explanation under `Planned tests`; never defer a regression test or replace an unknown path.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:BEH-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative regression test paths | modified | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (the behaviour already exists at the listed paths), removed, test-only (the tests are the whole delivery; write - under Expected paths), document or configuration. Observable result: what a person can observe when the row is met. A plan that feeds several code steps adds a Steps column naming the step that delivers each row. -->

## Exact change

The fix MUST change the observed failure into the expected behavior TODO without altering TODO. [{{work.id}}:BEH-001]

## Regression and negative tests

TODO: Explain the regression and negative cases recorded as exact paths in the planned implementation
evidence table. Bind every test to its corresponding fully qualified REQ/BEH/IFC/AC/CON clause ID.
