# Requirements Specification — {{workId}}

This specification follows the structure of ISO/IEC/IEEE 29148 adapted to Epic
scope. It is the approved input to Story planning: the planning phase allocates
these exact `REQ-nnn` and `AC-nnn` identifiers to Stories, so identifiers must
stay stable across regenerations. Renumbering breaks approved traceability.

Every requirement and acceptance criterion must cite a pinned source ID plus a
page, frame, or section. A requirement with no citation is an assumption and
belongs in the assumptions table until it is sourced.

## Executive summary

- Problem or opportunity:
- Desired business outcome:
- Users and stakeholders:
- Success measures:
- Scope in one sentence:

## Definitions and glossary

Define every domain term, abbreviation, and role used below. Ambiguous vocabulary
is the most common cause of a requirement being implemented incorrectly.

| Term | Definition | Source |
| --- | --- | --- |
| | | |

## Scope

### In scope

-

### Out of scope

-

### Interfaces to systems outside this Epic

| External system | Direction | Purpose | Owner |
| --- | --- | --- | --- |
| | Inbound / Outbound / Bidirectional | | |

## Assumptions and constraints

| ID | Statement | Type | Basis | Impact if wrong |
| --- | --- | --- | --- | --- |
| ASM-001 | | Assumption | | |
| CON-001 | | Constraint | Regulatory / Technical / Commercial / Timeline | |

## Requirements

Each requirement states a single testable capability. Use "shall" for obligations.
Priority uses MoSCoW; verification uses the ISO/IEC/IEEE 29148 methods
(inspection, analysis, demonstration, or test).

### REQ-001

- Statement:
- Rationale:
- Priority: Must / Should / Could / Won't
- Verification method: Inspection / Analysis / Demonstration / Test
- Source citations:
- Dependencies:
- Affected users or systems:
- Assumptions relied on:

## Business rules

Rules constrain behaviour across many requirements; state them once and reference
them rather than repeating the logic in each requirement.

### BR-001

- Rule:
- Applies to:
- Exceptions:
- Owner:
- Source citations:

## Acceptance criteria

Written in Given/When/Then so they are directly executable as tests. Every
criterion must map to at least one requirement, and every Must requirement must
have at least one criterion.

### AC-001

- Given:
- When:
- Then:
- Requirements: REQ-001
- Verification method: Inspection / Analysis / Demonstration / Test
- Test data or preconditions:
- Source citations:

## Non-functional requirements

State a measurable threshold and how it will be verified. "Fast" and "secure" are
not requirements; a percentile latency budget and a named control are.

### NFR-001

- Quality attribute: Performance / Availability / Security / Privacy / Accessibility / Usability / Portability / Maintainability / Observability
- Measurable expectation:
- Measurement conditions (load, percentile, window):
- Verification method:
- Consequence of breach:
- Source citations:

## Data requirements

| ID | Data entity | Classification | Retention | Residency | Owner | Source citations |
| --- | --- | --- | --- | --- | --- | --- |
| DR-001 | | Public / Internal / Confidential / Restricted | | | | |

Record new entities, changed fields, migration needs, and any personal data that
triggers a privacy assessment.

## Integration requirements

| ID | Interface | Type | Direction | Contract | Compatibility expectation | Source citations |
| --- | --- | --- | --- | --- | --- | --- |
| IR-001 | | API / Event / File / Database / UI | | | Backward compatible / Breaking | |

## Experience and accessibility

- Target platforms and viewports:
- Accessibility conformance target (for example WCAG 2.2 AA):
- Localization and internationalization needs:
- Error, empty, and degraded states required:

## Compliance and regulatory requirements

| ID | Obligation | Regime | Control required | Evidence for audit | Source citations |
| --- | --- | --- | --- | --- | --- |
| CR-001 | | | | | |

## Dependencies and risks

| ID | Description | Type | Owner | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- | --- | --- |
| DEP-001 | | Dependency | | | | |
| RSK-001 | | Risk | | High / Medium / Low | High / Medium / Low | |

## Open questions and decisions

Carry forward anything still unresolved from source gaps, plus decisions taken
while writing this specification.

| ID | Question or decision | Status | Resolution | Decided by | Date |
| --- | --- | --- | --- | --- | --- |
| Q-001 | | Open / Decided | | | |

## Requirements coverage

Every requirement must appear here with its criteria, and every source that
justified a requirement must be accounted for. Unsourced requirements and unused
sources are both defects.

| Requirement | Priority | Acceptance criteria | Source citations | Verification |
| --- | --- | --- | --- | --- |
| REQ-001 | Must | AC-001 | SRC-000000000000 §  | Test |

## Source coverage

| Source ID | Page, frame, or section | Covered requirements | Notes |
| --- | --- | --- | --- |
| SRC-000000000000 | | REQ-001, AC-001 | |

## Quality checklist

The requirements phase should not be submitted until each row holds.

| Check | Status |
| --- | --- |
| Every requirement is singular, testable, and free of solution bias | |
| Every requirement and criterion cites a pinned source and locator | |
| Every Must requirement has at least one acceptance criterion | |
| Non-functional requirements state measurable thresholds | |
| No requirement contradicts another | |
| Glossary covers every domain term used | |
| Identifiers are unchanged from the previous approved generation | |
