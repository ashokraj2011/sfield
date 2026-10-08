---
name: demo-web-screenshot-check
description: Compares an authorized live web application to pinned screenshots and runs approved E2E scenarios, producing fresh evidence and an honest verdict.
metadata:
  sflow-label: Demo web screenshot and E2E check
---

1. Use /sf-scenario-check's verified route. Read the approved intake and current change request.
   Pin tested commit/source hash, screenshot document hashes, commands and environment. Retest
   the current demo-web-repair publication and its structured Code receipt, never an old report.
2. Execute only authorized startup/test commands and origins. For Playwright MCP, verify host
   readiness and a live smoke check, then record actual tool calls/output through the governed
   MCP boundary. A repository E2E runner may be used instead; retain its real structured report.
   Do not install tools silently, use production data or fabricate browser records.
3. Apply approved viewport, test data, font/animation rules and masks. Capture fresh observed
   screenshots under CLI-returned artifact paths, together with source/observed SHA-256, route,
   state, browser and relevant console/network failures. Store evidence in the Story, not loose
   repository-root files. Preserve the approved reference; never auto-update a visual baseline.
4. Compare each visual assertion and execute each interaction assertion. Record scenario/AC ID,
   actual observation, fresh evidence path/hash, report test identity, comparison method, agreed
   tolerance and result. A screenshot alone or a model's claim is not executable test assurance.
   If exact image diff is required but unavailable, report blocked rather than claiming a match.
5. Report pass only when every required scenario ran and passed. Report repair for demonstrated
   application or test defects, with clause IDs and bounded allowed paths; blocked for tool,
   access, source or infrastructure gaps. Never mutate code/tests in this phase or soften a
   verdict at the loop limit. Show evidence for human review and the same verdict for submission
   via --decision verdict=pass|repair|blocked. Do not submit, approve or accept risk as the user.
