# {{work.id}} — Publication and PR review

## Publication boundary

{{inputs}}

Record the configured remote, selected base branch and pinned base commit, isolated Story branch,
current Story commit/tree, and exact destination ref. The destination must be the Story ref; never
write or force-update the selected base. State whether the branch is already published or has a
pending-publication recovery record.

## Change and coverage summary

Summarize changed Page Objects, specs, fixtures, helpers, and configuration. Map the proposed PR to
approved `[POC:AC-nnn]` items and the regression footprint. Include an exact diff/stat and identify
any non-test source change for special review.

## Validation evidence

Link the approved validation generation, commands, exit codes, scenario matrix, Playwright reports,
traces, screenshots, logs, and governed MCP provenance. Do not describe failed, stale, blocked, or
not-run evidence as green.

## Residual risk and rollback

Document uncovered journeys/browsers/viewports, flake risk, environment limitations, test-data
effects, follow-up work, and how reviewers can revert or disable the added tests safely.

## Human decision

Prepare a proposed PR title, description, coverage summary, reviewer checklist, base ref, and head
ref. This artifact **does not create a pull request**. Record the independent quality and
engineering decisions required by policy. Only after both approvals may a contributor explicitly
invoke the governed publication/PR action; a refusal or rejection routes back to the named phase.
