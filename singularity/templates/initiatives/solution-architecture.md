<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

The technical design: what is being built, how the parts fit, and which constraints shaped it. Cite
the repository world model for anything that already exists — if this document and the code disagree,
the code is right and this document is stale.

## Context and constraints

What the design has to work within: existing systems, regulatory limits, deadlines, team shape.

| Constraint | Type | Consequence for the design |
|---|---|---|

## Target architecture

The components and how they relate. Say which already exist, which change, and which are new.

| Component | Repository | Status | Responsibility |
|---|---|---|---|
| | | existing / changed / new | |

## Interfaces and contracts

Every boundary this initiative crosses. Contract detail belongs in the interface-contract artifact;
name it here.

| Interface | Type | Producer → consumer | Contract | Breaking? |
|---|---|---|---|---|

## Data

What data is stored, moved, or derived — and what class it falls into.

| Data | Classification | Store | Retention | Migration needed |
|---|---|---|---|---|

## Cross-cutting concerns

State the position taken on each, or say explicitly that it is unchanged.

| Concern | Position | Evidence |
|---|---|---|
| Security | | |
| Privacy | | |
| Performance | | |
| Availability | | |
| Observability | | |
| Cost | | |

## Options considered

The alternatives and why they were not chosen. An architecture with no rejected options was not
designed, it was assumed. Decisions with lasting consequence also belong in the ADR log.

| Option | Strengths | Why not chosen |
|---|---|---|

## Failure modes

How this design fails, and what happens when it does.

| Failure | Blast radius | Detection | Recovery |
|---|---|---|---|

## Rollback

How to undo this if it goes wrong in production. If there is no rollback, say so explicitly rather
than leaving it blank.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

World-model views, pinned sources, and approved upstream artifacts.

{{inputs}}
