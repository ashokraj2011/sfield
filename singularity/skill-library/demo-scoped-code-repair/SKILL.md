---
name: demo-scoped-code-repair
description: Repairs approved demonstrated defects with traceable source changes and executable regressions, then returns the current revision to the independent Demo checker.
metadata:
  sflow-label: Demo scoped code repair
---

1. Follow /sf-code's open generation and preserved-work repair protocol. Read the approved intake,
   exact current failure report and rework request. Diagnose implicated source/tests using bounded
   reads. Unclear intent or scope returns to reviewed intake; it is not permission to expand work.
2. Change only authorized paths. Keep unrelated work, source documents, screenshot baselines,
   visual tolerances, security boundaries and required tests intact. Do not make a failure pass by
   removing an assertion, skipping the case or updating the expected image without authority.
3. Add executable regressions for each repaired criterion and canonical @ac:WORK-ID:AC-nnn tags;
   product @clause:WORK-ID:REQ-nnn/AC-nnn bindings need real explanatory rationales. Use exact
   approved identities, including case, and the supported comment form for the language.
4. Use the canonical configured test execution and fresh receipt. Hidden approved argv are not
   missing configuration. If tools or configuration are absent, follow /sf-test-setup or returned
   recovery; do not rerun publication blindly or waive failing tests. Preserve drafts and evidence
   while resolving an admitted owned repair; decisions, witnesses and integrity remain separate.
5. Complete the configured summary with root cause, changed clauses, fresh results and risks.
   At submission record --decision next=recheck for a completed repair or next=revise-intake for a
   reviewed scope change. After human engineering approval the router returns to demo-check (or
   intake for changed intent). Do not skip independent retesting, accept a witness or close here.
