<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

One document: what this Epic requires, and what changing it touches. Every statement below cites a
pinned source or the repository world model. Anything the evidence does not settle belongs in
**Open questions**, not in a requirement.

## Context

What is being asked for and why, in the business's own terms.

## Scope

**In scope.** What this Epic changes.

**Out of scope.** What it deliberately does not, so the boundary is on the record.

## Requirements

Stable IDs. One testable statement each. Cite the source that establishes it.

| ID | Requirement | Priority | Source |
|---|---|---|---|
| REQ-1 | | must / should / could | |

## Acceptance criteria

Given / When / Then, one row per requirement it proves. A criterion no one can run is not a
criterion.

| ID | Proves | Given | When | Then |
|---|---|---|---|---|
| AC-1 | REQ-1 | | | |

## Impact analysis

What this change reaches, grounded in the repository world model rather than assumed. Name the
real components; if the world model does not describe a component, say so instead of guessing.

### Components and behaviour

| Component | Change | Why | Evidence |
|---|---|---|---|

### Dependencies and contracts

Interfaces, schemas, configuration and data this touches, and who else consumes them.

### Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|

### Test impact

Which existing tests cover the affected behaviour, and what new coverage the requirements imply.

## Open questions

What the pinned sources do not answer, and who can answer it. An Epic that reaches planning with
these unanswered carries them forward as risk.

| Question | Blocks | Owner |
|---|---|---|

## Evidence

Sources this document is derived from, by pinned ID. Requirements may cite nothing else.

{{inputs}}
