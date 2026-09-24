# {{work.id}} — Mobile Implementation Specification

## Approved design inputs

{{inputs}}

## Acceptance criteria

| Acceptance criterion | User-visible requirement | Screens/states | Verification |
|---|---|---|---|
| [{{work.id}}:AC-001] | TODO | SCREEN-001 | TODO |

## Specification traceability

| Spec ID | Acceptance criteria | Screens/interactions | Component maps | Planned code/tests | Status |
|---|---|---|---|---|---|
| [{{work.id}}:IFC-001] | `{{work.id}}:AC-001` | SCREEN-001 / INT-001 | MAP-001 | TODO | planned |

Add, remove, and renumber the example anchors so every approved mobile behavior and interface has
one stable, fully qualified clause ID. Never leave a display-only `AC-001` or `SPEC-001` as the
identity used by implementation or test evidence.

## Planned implementation evidence

Add exactly one row for every authoritative clause above. Use its fully qualified clause ID. List
only exact repository-relative source and test paths in backticks; do not use directories, globs,
module names, or prose in path cells. For a genuinely non-testable clause, write
`not-applicable:` followed by your concrete reviewed explanation under `Planned tests`; never use
that disposition to defer a test or replace a path that has not yet been identified.

| Clause | Expected paths | Planned tests |
|---|---|---|
| `{{work.id}}:AC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths |
| `{{work.id}}:IFC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths |

## Navigation and lifecycle contract

TODO: Define routes, parameters, deep links, modal behavior, back behavior, restoration, authentication gates, and application lifecycle handling.

## State, data, and API contract

TODO: Define view state, validation, loading, empty, error, offline, retry, caching, concurrency, API/schema, and persistence behavior.

## Responsive and adaptive layout contract

| Screen ID | Reference size | Width/height behavior | Insets/keyboard | Text scaling | Tablet/orientation |
|---|---|---|---|---|---|
| SCREEN-001 | TODO | TODO | TODO | TODO | TODO |

## Accessibility and localization

TODO: Specify semantics, labels, roles, focus order, touch targets, contrast, reduce-motion behavior, dynamic type/font scaling, localization, right-to-left layout, and automated checks.

## File-level implementation plan

| Spec ID | Module/file | Change | Reused component/token | Test target |
|---|---|---|---|---|
| `{{work.id}}:IFC-001` | TODO | TODO | MAP-001 / TODO | TODO |

## Security, privacy, telemetry, and failure behavior

TODO: Define sensitive-data handling, logging exclusions, analytics events, operational diagnostics, permissions, and safe failure behavior.

## Visual verification plan

| Screen/state | Reference evidence | Device matrix | Capture method | Allowed deviation |
|---|---|---|---|---|
| SCREEN-001 | TODO | TODO | TODO | TODO |
