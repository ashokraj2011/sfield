# {{work.id}} — Governed UI exploration

## Authorized target

{{inputs}}

Record the approved environment, exact origin, browser project, viewport, source revision, feature
flags, test-data identity, and Playwright host attestation. Refer to secret names only. Stop if the
browser is redirected outside the approved origin or the environment cannot be identified.

## Observed journeys and states

| Scenario / AC | Actions performed | Observed state | Expected state | Result |
|---|---|---|---|---|
| `[POC:AC-nnn]` | navigation and human-like actions | exact observation | approved expectation | matched/gap/blocked |

Use browser observations to refine the impact map. Do not turn a transient live response into a
product requirement and do not execute destructive or production-like actions without explicit
authorization.

## Accessibility and locator evidence

| Element / state | Role and accessible name | Candidate stable locator | Evidence |
|---|---|---|---|
| Record observed control | role/name/state from snapshot | role, label, or approved test id | MCP record / snapshot |

Prefer accessibility semantics and existing test IDs. Mark CSS structure, generated classes,
coordinates, and XPath as brittle; do not select them simply because they make one run pass.

## Visual and runtime evidence

Inventory each governed MCP call and each durable screenshot, accessibility snapshot, console log,
network summary, trace, or video. Record its repository-relative path and SHA-256/provenance record.
Run `mcp smoke playwright --url <EXACT-APPROVED-URL>` during this generation. The live MCP host's
observed final URL is the navigation receipt; agent-declared navigation records are refused.
Captured `browser_snapshot` output must report a `Page URL` on the same authorized origin.
Redact or exclude secrets and personal data before publication. A screenshot is evidence of one
state at one viewport, not proof of every browser or responsive layout.

## Coverage gaps

List states that were not observed, why they were unavailable, and whether generation may proceed.
Separate application defects, access blockers, environment failures, and unknown expectations.

## Planned test generation evidence

Translate the approved `[POC:AC-nnn]` clauses and observed material risks into the exact repository
contract for the next test-generation phase. Add exactly one row for every authoritative clause,
using its fully qualified ID. List only exact repository-relative source and test paths in backticks;
do not use directories, globs, module names, or prose in path cells. Here, `Expected paths` identifies
the repository-owned test seam or helper expected to change; it never authorizes product-code changes.
For a genuinely non-testable clause, write `not-applicable:` followed by your concrete reviewed
explanation under `Planned tests`; never defer a test or replace an unknown path with that disposition.

| Clause | Expected paths | Planned tests |
|---|---|---|
| `POC:AC-001` | TODO: replace with exact backticked repository-relative test-automation paths | TODO: replace with exact backticked repository-relative Playwright test paths |
