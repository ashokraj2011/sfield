<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

Whether this can be built, verified and shipped by the pipeline rather than by a person. The test is
not that a release is possible, but that it is repeatable by someone who was not there.

## Pipeline per repository

| Repository | Build | Automated checks | Deploys to | Manual steps |
|---|---|---|---|---|
| | | | | none / listed below |

## Manual steps

Every step a human must perform. Each is a place a release can go differently from the last one.

| Step | Why it is manual | Who performs it | Plan to automate |
|---|---|---|---|

## Gates in the pipeline

What the pipeline refuses to let through, which is what makes it a control rather than a
convenience.

| Gate | Enforces | Blocking |
|---|---|---|
| | | yes / advisory |

## Artifacts and provenance

What is produced, where it is stored, and how a deployed artifact is traced back to its commit.

| Artifact | Built from | Stored at | Retention |
|---|---|---|---|

## Secrets and configuration

How the pipeline obtains what it needs without a person holding it. Name the mechanism, not the
values.

| Need | Source | Rotation |
|---|---|---|

## Rollback

How the pipeline puts the previous version back, and when that was last exercised.

| Repository | Rollback method | Last exercised |
|---|---|---|

## Readiness

| Criterion | Met | Evidence |
|---|---|---|

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
