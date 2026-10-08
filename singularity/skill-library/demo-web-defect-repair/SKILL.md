---
name: demo-web-defect-repair
description: Repairs demonstrated screenshot or interaction defects with scoped web changes and executable clause-bound regression tests before independent retesting.
metadata:
  sflow-label: Demo web defect repair
---

1. Stay inside /sf-code's open generation intent and publication protocol. Read approved intake,
   the latest accepted failure report and current rework request, including pinned retest input
   hashes. If the request changes intent or allowed paths, return for clarification/amendment.
2. Diagnose the evidenced root cause using bounded reads of the implicated component, styles,
   state and existing tests. Make the smallest authorized repair. Preserve other people's edits,
   screenshot references, tolerances, security boundaries and unrelated features.
3. Add executable regression assertions for the failed scenario, with exact @ac:WORK-ID:AC-nnn
   and source @clause:WORK-ID:REQ-nnn bindings. Cover interaction as well as visible output;
   do not make a failing test green by dropping it, widening masks or updating expected images.
4. Run the approved affected tests, browser scenarios and regression scope. The canonical Code
   gate must retain fresh structured test receipts. Missing runner/configuration uses the returned
   /sf-test-setup or /sf-recover route; failed tests remain failures. No hook/check bypasses.
5. Explain code changes, test identities, screenshot evidence and residual risks in the repair
   summary. Publish once when ready. Hand off to demo-web-tester for fresh independent retest
   and human acceptance. Never run an unbounded self-repair loop or approve your own result.
