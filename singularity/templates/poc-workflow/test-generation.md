# {{work.id}} — Playwright test generation

## Repository-native design

{{inputs}}

Describe the detected Playwright configuration, language, package manager, fixtures, Page Object
Model convention, test root, reporting, and CI pattern. Explain how the implementation follows
those existing boundaries. If no convention exists, record the smallest proposed layout and obtain
engineering approval rather than inventing a framework migration.

## Files changed

| Path | Created/updated | Purpose | Governed source |
|---|---|---|---|
| Exact repository-relative path | created/updated | POM, spec, fixture, config, or helper | scenario / evidence reference |

Keep all changes on the isolated Story branch. Generated source must not contain credentials,
environment-specific tokens, mutable repository URLs, or direct commands that push or create PRs.

## Scenario traceability

| Acceptance / risk | Test title and path | Assertions | Negative/boundary coverage |
|---|---|---|---|
| `[POC:AC-nnn]` or impact item | exact spec location | observable expectations | exact variants or not applicable |

Every automated claim must trace to approved intent or observed risk. Do not weaken an expectation,
add arbitrary waits, or catch an exception merely to produce a passing run.

## Locator and test-data strategy

Document role/name/test-id locators, Page Object responsibilities, fixture lifecycle, isolation,
cleanup, determinism, network handling, and parallel-safety. Explain every less-stable locator and
the evidence that made it necessary. Secret values remain host-managed.

## Deviations and residual risk

Record deviations from repository conventions, scenarios left manual or not-run, and assumptions
that validation must test. A generated file is an implementation candidate, not passing evidence.
