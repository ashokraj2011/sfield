# Implementation plan — {{work.id}}

Derived from the approved specification. Cite the clause each decision serves, so convergence can
join intent to implementation at requirement altitude rather than by path `[SPK:REQ-071]`.

## Agent brief

<!--
Summarize the selected approach, affected surfaces, sequencing, proof strategy, and principal risks
for downstream agents. Keep exact commands and source paths when they are operationally important.
The complete approved plan remains available through its hash-bound expansion reference.
-->

TODO: Summarize the selected implementation approach, affected surfaces, proof strategy, and principal risks.

## Approach

TODO: Explain how this will be built and why this approach was selected.

## Affected surfaces

TODO: Identify the modules, contracts, data, and interfaces this touches. Expected paths are a
planning aid; the authority on what actually changed remains reconciliation `[SPK:CON-031]`.

| Surface | Change | Serves |
|---|---|---|
| `<path or module>` | <what changes> | [{{work.id}}:REQ-001] |

## Sequencing

TODO: State the implementation order and what each step unblocks.

## Test strategy

TODO: Explain how each authoritative clause will be proved. Add exactly one row per clause, using its
fully qualified ID (for example, `{{work.id}}:REQ-001`, never only `REQ-001`). `Expected paths` and
`Planned tests` must contain exact repository-relative paths in backticks; directories, globs, module
names, and prose are not paths. Multiple exact paths may be listed as separate backticked values.
For a genuinely non-testable clause, write `not-applicable:` followed by your concrete reviewed
explanation in `Planned tests`. Do not use it to defer a test or to replace an unknown path.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:REQ-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (the behaviour already exists at the listed paths), removed, test-only (the tests are the whole delivery; write - under Expected paths), document or configuration. Observable result: what a person can observe when the row is met. A plan that feeds several code steps adds a Steps column naming the step that delivers each row. -->

## Supporting files

<!-- Optional. List each file the code may change that cannot carry a @clause tag (a manifest, a lockfile, CI configuration, repository metadata, documentation): one exact backticked repository path per bullet, then its reason, for example: - `package.json` — adds the ledger client. Application source, tests and migrations are never supporting files: give them a clause row. Approval refuses any other changed path no clause claims. Delete this section when there are none. -->

## Constitution articles

TODO: List the constitution article IDs this plan is bound by `[SPK:REQ-100]`.

## Risks and rollback

TODO: Describe what could go wrong, how it would be detected, and how to roll it back.
