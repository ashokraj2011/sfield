---
name: demo-code-acceptance-check
description: Checks current code with real tests and screenshot/document comparisons, retaining fresh clause-bound evidence without changing the application or expected results.
metadata:
  sflow-label: Demo code acceptance check
---

1. Follow the canonical scenario-check protocol. Read the approved intake and the current rework
   request. Pin current commit/source hash and source-document hashes. On returning from Repair,
   inspect the retained repair publication/receipt from workflow history; the open Check generation
   must test the repaired current code, never replay the first report or depend on a future phase.
2. Use only approved commands and local/test origins. Playwright MCP is optional: require live
   smoke/provenance when used, or run an approved existing repository tool. Do not silently install
   dependencies, grant access or use production data. Record actual argv/cwd, exit status, executed
   test identities, environment and fresh structured report paths/hashes.
3. Compare each approved screenshot/document assertion and execute each interaction assertion.
   Retain new observed images/reports under CLI-declared Story evidence paths and contracts, not
   loose repository files. Record method, viewport/state, agreed tolerance and actual differences.
   An agent's visual opinion is not a pixel-diff test or an authorized human witness.
4. Map every scenario/AC to actual observations and evidence. Pass requires every required case to
   run and pass; zero tests, skipped required cases, stale reports, unavailable sources/tools or
   inconclusive results are blocked. Demonstrated product/test defects mean repair, with exact
   failed clauses, allowed paths and regression expectations. Never change code or baselines here.
5. Present the same verdict at submission using --decision verdict=pass|repair|blocked. Follow
   returned route commands rather than inventing a transition. Human approval reviews the evidence
   and route; a no-additional-repair pass requires the returned implementation-applicability
   decision. Human disagreement uses reject/rework. At the round limit ask for direction, not a
   false pass, automatic waiver or another unbounded retry. Only pass routes to closing documents.
