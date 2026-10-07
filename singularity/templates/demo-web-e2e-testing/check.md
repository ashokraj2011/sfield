# {{work.id}} — Demo web E2E and screenshot results

{{inputs}}

## Pinned inputs and tested revision

TODO: Cite approved intake generation/hash and reference screenshot document IDs/hashes. Record
tested commit and source hash. For retest cite the current demo-web-repair publication, generation
and structured test receipt, together with the latest approved defect/change request.

## Browser and test execution

TODO: Retain actual command/tool, argv/cwd, authorized environment, browser/version, viewport,
start/end, exit code, executed test IDs and fresh structured report paths/hashes. If using Playwright
MCP, cite live smoke and actual governed tool records. Note skipped cases, zero tests, unavailable
tools and console/network failures. Do not modify source, tests or expected screenshots here.

## Screenshot comparison

| Scenario | Reference document / SHA-256 | Fresh observed image / SHA-256 | Route / state / viewport | Method and approved tolerance / masks | Actual difference and result |
|---|---|---|---|---|---|
| WEB-001 | TODO: Approved reference | TODO: Fresh Story evidence | TODO: Same state | TODO: Human visual inspection or executed image-diff assertion | TODO: Evidence-backed finding |

TODO: Explain limitations. A model's visual judgment is not exact image-diff or test assurance.
Do not overwrite the reference, relax tolerance or reuse an old screenshot to manufacture a pass.

## Scenario results

| Scenario | Approved criterion | Observed interaction / visual assertion | Fresh evidence / test identity | Result | Failure classification |
|---|---|---|---|---|---|
| WEB-001 | `{{work.id}}:AC-001` | TODO: Actual observation | TODO: Path/hash and executed identity | TODO: pass / fail / blocked | TODO: product / test / environment / infrastructure |

## Agent verdict and repair request

TODO: Set verdict=pass only if every required scenario ran and passed; repair for a demonstrated
product/test defect; blocked for unavailable tools, images, access or inconclusive evidence. Give
exact failed clause IDs, root-cause clues, allowed paths and regression checks. Use this same verdict
at submission with --decision verdict=pass|repair|blocked. A loop limit never changes the result.

## Human acceptance

TODO: Present evidence and the proposed route for authorized human review; do not claim approval.
Completion requires both agent pass and human acceptance. Initial no-change completion also needs
quality-reviewer implementation-applicability. Disagreement returns to this check or intake rather
than silently changing requirements. At the round limit request a reviewed attempt, revised intake
or cancellation. Code repair belongs to demo-web-repair, not this checking phase.
