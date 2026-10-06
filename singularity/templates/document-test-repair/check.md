# {{work.id}} — Scenario acceptance report

{{inputs}}

## Pinned inputs and tested revision

TODO: Cite approved intake generation/hash, retained source documents/screenshots and tested
commit/source hash. For retest cite the current scenario-repair generation, Code publication and
fresh kernel structured test receipt. For initial testing record that no repair has occurred.

## Tool execution and evidence

TODO: Retain exact command/tool, argv/cwd, authorized environment, start/end, exit codes,
executed test IDs, fresh report/output paths and SHA-256. Note skips, zero tests, unavailable
tools and stale reports. If Playwright is selected, cite current smoke and governed MCP records;
browser observations do not replace structured Code test execution. Do not edit source or tests.

## Scenario results

| Scenario | Approved criterion | Observed assertion | Fresh evidence | Result | Failure classification |
|---|---|---|---|---|---|
| SC-001 | `{{work.id}}:AC-001` | TODO: Exact observation | TODO: Hash-bound output | TODO: pass / fail / blocked | TODO: product / test / environment / infrastructure |

## Agent verdict and repair request

TODO: Choose one `verdict`: `pass` only if every required scenario ran with passing assertions;
`repair` for demonstrated product/test defects; `blocked` for missing tools, inaccessible sources,
environment/infrastructure failures or inconclusive evidence. Give the exact defects, implicated
clauses and allowed repair paths. Pass this same verdict to submission using `--decision verdict=...`.
Never change it because the loop limit is reached. Code changes belong to scenario-repair.

## Human acceptance

TODO: Present the evidence and proposed route for the authorized human. Do not fill in an approval
on their behalf. A human may accept a failure report to authorize repair, but Story completion
requires the submitted agent pass AND human acceptance of that report. For an initial pass,
the quality reviewer records implementation as not applicable with a reason tied to fresh evidence.
If the human disagrees, reject to document-intake or the current check for correction; no hidden
change to approved expectations. At the round limit, seek explicit direction or cancellation.
