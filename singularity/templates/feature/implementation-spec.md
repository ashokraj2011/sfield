# {{work.id}} — Implementation Specification

## Planned implementation evidence

Add exactly one row for every authoritative clause. Use a fully qualified clause ID. List only exact
repository-relative source and test paths in backticks; do not use directories, globs, module names,
or prose in path cells. For a genuinely non-testable clause, write `not-applicable:` followed by
your concrete reviewed explanation under `Planned tests`; never defer a test or replace an unknown path.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:IFC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (behaviour already at the listed paths), removed, test-only (tests are the whole delivery; Expected paths is -), document, configuration, or evidence (retained files under this Story's evidence/ directory). Do not put screenshots in Planned tests or product-source rows. An evidence AC needs a primary visual/inspection Verification contract; file presence is not a visual pass. Observable result states what is observed. Multi-code-step plans add Steps to allocate each row. -->

## APIs, schemas, and contracts

The implementation MUST preserve or introduce the following exact contract: TODO. [{{work.id}}:IFC-001]

## File-level implementation plan

TODO: Identify components and expected changes without generating code.

## Security, observability, migration, and rollback

The implementation MUST satisfy the security, observability, migration, and rollback obligations TODO. [{{work.id}}:CON-002]

## Test specification

TODO: Explain the tests recorded as exact paths in the planned implementation evidence table. Bind
every test to its corresponding fully qualified REQ/BEH/IFC/AC/CON clause ID.
