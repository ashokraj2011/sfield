# {{work.id}} — Playwright testing review

## Agent brief

<!--
Summarize the approved Specification generation, published Code generation, structured Code
test receipt, authorized browser target, observed behavior, and any required rework. A browser
observation is not an executable-test verdict or permission to change the Specification.
-->

## Exact inputs and committed test receipt

TODO: Cite the approved Specification generation and SHA-256, the Code publication/review commit,
and the kernel-validated `context/code-delivery/implementation-genN.json` and
`context/code-delivery/tests/implementation-genN-*.json` receipts. Record the test command ID,
discovered/passed/failed counts, and any unavailable coverage. Do not call MCP observations a
passing structured test result. The Code receipt is checked again before this phase may publish,
submit, or be approved.

## Authorized target and environment

TODO: State the exact approved browser origin, environment, viewport and test-data boundary. Use
the governed Playwright host readiness and same-origin smoke checks; stop if the approved target,
host, authentication profile, or environment is unavailable or changed.

## Playwright observations

TODO: Cite this generation's governed `browser_navigate`, `browser_snapshot`, and
`browser_take_screenshot` evidence records, their output hashes, observed URL, and any optional
console/network observations.
Describe what was actually seen. A screenshot, MCP text, or model assertion is observation only;
it cannot replace the repository test runner's structured receipt.

## Clause results and gaps

| Specification clause | Published Code and test evidence | Browser observation | Verdict and gap |
|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: Exact paths, generation, and receipt | TODO: Evidence record | TODO: observed / failed / unavailable |

## Correction decision

TODO: State one reviewable decision: no correction, reject to Code (`implementation`) for a
source/test defect, propose an intent amendment for changed approved requirements, or remain in
Testing for an environment/evidence correction. Name the affected clauses and evidence hashes.
Rejection starts a new governed Code generation and invalidates downstream approvals; an intent
amendment leaves the approved Specification untouched until separate product approval creates a
new generation. Do not edit source in Testing or silently
advance after a failed or unavailable result.

## Residual risk

TODO: Distinguish observed browser behavior, passing structured Code tests, and unverified
claims. State whether Code checking can proceed and what remains for independent review.
