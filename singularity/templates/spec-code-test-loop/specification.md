# {{work.id}} — Specification

## Agent brief

<!--
Summarize approved behavior, users, exclusions, and the exact clause-to-test plan for Code and
Playwright review. Do not claim that a browser observation or a drafted test proves the behavior.
-->

## Actors

TODO: Identify who uses the feature and which actions each actor may perform.

## User scenarios

TODO: Describe the starting state, user action, visible outcome, and relevant failure and empty
states. Identify the approved browser origin and environment only when they are known; otherwise
record an open question before review.

## Requirements

Write one testable obligation per stable, fully qualified clause ID. Replace the examples with
the actual Story requirements and acceptance criteria; preserve clause IDs across amendments
unless the obligation is withdrawn and that withdrawal is explicitly reviewed.

- TODO: State an observable behavior. [{{work.id}}:REQ-001]
- TODO: State an independently checkable acceptance outcome. [{{work.id}}:AC-001]

## Boundary and non-functional requirements

TODO: Record limits, error handling, permissions, accessibility, privacy, and measurable
performance requirements or explain why a category is not applicable.

## Planned implementation evidence

Add exactly one row for every approved requirement and acceptance clause above. Use exact
repository-relative source and executable-test paths in backticks, not directories or globs.
If a clause truly cannot be tested, use `not-applicable:` followed by a concrete reviewer-approved
reason. Browser observations may supplement the planned executable tests, never replace them.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:REQ-001` | TODO: `src/example.js` | TODO: `test/example.test.js` | new | TODO: what a person can observe when it works |
| `{{work.id}}:AC-001` | TODO: `src/example.js` | TODO: `test/example.test.js` | new | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing (the behaviour already exists at the listed paths), removed, test-only (the tests are the whole delivery; write - under Expected paths), document or configuration. Observable result: what a person can observe when the row is met. A plan that feeds several code steps adds a Steps column naming the step that delivers each row. -->

## Evidence and assumptions

TODO: Cite the request, pinned repository and document inputs, approved browser target, test
data boundary, and any unresolved assumptions. Do not guess a requirement from an unavailable
source or silently change an approved obligation during Code or Playwright testing.

## Out of scope

TODO: Name excluded behavior and environments explicitly.
