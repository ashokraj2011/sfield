# Jira and Git Materialization Report — {{workId}}

The handoff record for the moment planning became delivery. It states exactly
what was created, from which approved plan, and what remains outstanding — so a
reader months later can reconstruct how each Story branch came to exist.

Materialization is resumable. If it was retried, record every attempt rather than
only the successful one.

## Result

| Field | Value |
| --- | --- |
| Epic | `{{workId}}` |
| Story plan hash applied | |
| Jira write plan hash applied | |
| Stories planned | |
| Stories created | |
| Stories attached to existing issues | |
| Branches created | |
| Outcome | Complete / Partial / Failed |
| Performed by | |
| Completed at | |

## Jira Story receipts

One row per Story. The numeric issue ID is the durable identity: a Jira key can
be re-keyed by a project move, and lineage must survive that.

| Plan ID | Jira key | Jira issue ID | Action | Parent Epic | Result |
| --- | --- | --- | --- | --- | --- |
| STORY-001 | | | Created / Attached / Skipped | | |

## Canonical branch receipts

| Story | Repository | Branch | Base branch | Base commit | Seed commit | Pushed |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | Yes / No |

Stories in the Epic's own repository are based on the Epic branch; Stories
elsewhere are based on that repository's default branch. Record which rule
applied where the base branch is not obvious.

## Traceability confirmation

| Check | Result |
| --- | --- |
| Every planned Story has a Jira identity | |
| Every Story has a canonical branch and pushed seed | |
| Every seed cites the approved Epic artifacts and hashes | |
| Requirement and acceptance allocations match the approved plan | |
| No branch was force-pushed or overwritten | |

## Deviations from the approved plan

Anything that differs from the approved Story plan, and the authority for it.

| Plan ID | Expected | Actual | Reason | Approved by |
| --- | --- | --- | --- | --- |
| | | | | |

## Retry or recovery actions

| Attempt | Started | Outcome | Failure reason | Recovery action |
| --- | --- | --- | --- | --- |
| 1 | | | | |

## Outstanding work

Anything a person must do before delivery can proceed — unmapped Stories, missing
repository access, Jira permissions, or manual branch protection changes.

-

## Next steps

- Story merge order: `singularity-flow epic merge-plan --epic {{workId}}`
- Per-Story pull requests: `singularity-flow pr <STORY-ID>`
- Epic lands when every blocking Story has merged into `{{workId}}`.
