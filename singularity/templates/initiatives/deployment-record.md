<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

What went to production, when, by whom, and from which commit. Written so that someone investigating
an incident three months from now can establish exactly what changed without asking anybody.

## Release

| Field | Value |
|---|---|
| Released on | |
| Released by | |
| Approved by | |
| Change record | |

## What was deployed

| Repository | Version or tag | Commit | Environment | Deployed at |
|---|---|---|---|---|

## Order and dependencies

The sequence deployments had to follow, and why. A record that lists components without their order
cannot be replayed.

| # | Component | Must follow | Reason |
|---|---|---|---|

## Configuration and migration

Changes outside the code: schema migrations, feature flags, configuration, infrastructure. These are
the changes that do not roll back with the artifact.

| Change | Applied at | Reversible | How it reverses |
|---|---|---|---|
| | | yes / no | |

## Verification at release

The checks run immediately after deployment, and their results.

| Check | Result | Run by | At |
|---|---|---|---|

## Incidents during release

| Time | What happened | Action taken | Resolved |
|---|---|---|---|

## Rollback position

What the rollback would be, and until when it stays available. A migration that has run usually
changes this answer.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
