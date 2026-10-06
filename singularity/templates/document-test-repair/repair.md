# {{work.id}} — Scenario repair summary

{{inputs}}

## Approved defect and scope

TODO: Cite approved intake and the latest human-accepted scenario report/change request by
generation and hash. Name failing clauses, root cause and allowed paths; preserve expectations.

## Changes and clause bindings

TODO: Explain each changed product path with its `@clause:{{work.id}}:REQ-...` binding and each
executable assertion with `@ac:{{work.id}}:AC-...`. Account for changes against the intake plan.
Documentation alone or changing expected outputs does not fix the demonstrated defect.

## Test results and regression evidence

TODO: Cite configured command IDs, exact argv/cwd, report adapter/path, execution exit and fresh
structured Code test receipts. Missing/failed tests are not passing evidence; use returned reviewed
test-configuration or recovery actions without editing protected policy on the Story branch.

## Remaining risks

TODO: Identify unresolved behavior, environmental limitations and the exact scenarios for retest.
Publication is not acceptance: scenario-tester must retest and a human must agree before completion.
