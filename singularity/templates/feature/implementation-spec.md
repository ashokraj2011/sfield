# {{work.id}} — Implementation Specification

## Planned implementation evidence

Add exactly one row for every authoritative clause. Use a fully qualified clause ID. List only exact
repository-relative source and test paths in backticks; do not use directories, globs, module names,
or prose in path cells. For a genuinely non-testable clause, write `not-applicable:` followed by
your concrete reviewed explanation under `Planned tests`; never defer a test or replace an unknown path.

| Clause | Expected paths | Planned tests |
|---|---|---|
| `{{work.id}}:IFC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths |

## APIs, schemas, and contracts

The implementation MUST preserve or introduce the following exact contract: TODO. [{{work.id}}:IFC-001]

## File-level implementation plan

TODO: Identify components and expected changes without generating code.

## Security, observability, migration, and rollback

The implementation MUST satisfy the security, observability, migration, and rollback obligations TODO. [{{work.id}}:CON-002]

## Test specification

TODO: Explain the tests recorded as exact paths in the planned implementation evidence table. Bind
every test to its corresponding fully qualified REQ/BEH/IFC/AC/CON clause ID.
