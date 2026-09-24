<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

The designed solution, at the level of detail that lets engineering estimate and build it. This is
where a concept becomes a specification: every screen, state and rule named, including the ones that
are not the happy path.

## What is being designed

The scope of this specification in one paragraph, and what it deliberately leaves to implementation.

## Flows

One row per flow a user can complete. An entry point nobody can reach is a flow that will not be
built.

| ID | Flow | Entry point | Success outcome | Requirement |
|---|---|---|---|---|
| FLOW-1 | | | | REQ-n |

## Screens and states

Every state, not only the populated one. Empty, loading, partial, error and permission-denied are
where most of the defects live and most of the design effort is skipped.

| Screen | State | Shown when | Content | Actions |
|---|---|---|---|---|
| | default / empty / loading / error / denied | | | |

## Rules and validation

Behaviour that is not visible in a layout: what is allowed, what is refused, and what the person is
told when it is refused.

| ID | Rule | Applies to | Refusal message |
|---|---|---|---|
| RULE-1 | | | |

## Content

Terms this initiative introduces or changes, and the wording that carries them. Naming decided here
is naming that does not get decided three times during build.

| Term | Meaning | Where it appears |
|---|---|---|

## Accessibility

The commitments this design makes, and the specific ones it is at risk of missing.

| Requirement | How this design meets it | Risk |
|---|---|---|

## Prototype register

What was built to test the design, and what state it is in. A prototype nobody can open is not
evidence.

| Prototype | Covers | Fidelity | Location | Still current |
|---|---|---|---|---|
| | FLOW-n | sketch / interactive / coded | | yes / no |

## Not designed

Parts of the scope deliberately left undesigned at this stage, and when they will be.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
