# {{work.id}} — Testing

## Agent brief

<!--
Summarize the executable-test verdict and any gap, including the exact Code receipt and source
revision. A written claim never replaces the kernel-validated test execution receipt.
-->

## Committed test results

This phase reviews tests run and committed during Code submission. It does not create a fresh
test-execution receipt; return to Code for changes that require another run and approval.

TODO: Cite the Code phase's committed `context/code-delivery/implementation-genN.json` and
`context/code-delivery/tests/implementation-genN-*.json` paths, command IDs, SHA-256 digests,
discovered/passed/failed counts, and the immutable review evidence commit. SFlow checks these
receipts before this phase can publish, submit, or be approved.

## Commands and environment

TODO: Describe the exact repository-native commands and environment recorded by the receipts.
Separate additional manual or exploratory checks from the executable-test proof.

## Acceptance and regression results

TODO: Map each Intake acceptance clause to passing test/source evidence. State failed, not-run,
or unavailable checks honestly and return to Code when source or tests require repair.

## Residual risk

TODO: State remaining gaps and the recommendation for Code checking.

## Feedback and rework decision

TODO: State either "No changes requested" or identify the exact failed criterion, Code
generation, test receipt, and requested correction. A reviewer may register a local feedback
file through `singularity-flow revision attachments` (Copilot: `/sf-revision-attachments`),
but registration only stages private evidence; it does not revise code or approve this phase.
If code or tests must change, reject this review to Code (`implementation`) and require a new
governed Code generation and passing test receipt. Do not edit source in Testing.
