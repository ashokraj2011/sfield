---
name: demo-evidence-bound-close
description: Produces a final source-bound closing report after a passing independently checked revision, with retained repair history, limitations and explicit human acceptance.
metadata:
  sflow-label: Demo evidence-bound closing
---

1. Follow the configured non-code phase protocol and returned artifact paths. Read approved intake
   and the latest approved passing Check publication. Cite exact generations, hashes and tested
   revision. Do not reuse an earlier pass after code, inputs or evidence changed; return to Check.
2. Reconcile every approved clause with actual test/inspection evidence, retained images and any
   required human witnesses. Distinguish skipped, waived, inconclusive and passed results. The
   closing report cannot create a test receipt, grant a witness or turn a risk decision into proof.
3. Include retained repair history and root causes, not just the current linear phase status.
   The Repair input is optional because an initial pass legitimately skips it. Record the exact
   human implementation-applicability decision explaining why no additional repair is needed.
4. Summarize final changes, affected tests, user-facing behavior, operational handoff and residual
   risks. Never edit product code/tests in closing. If a new defect or human disagreement appears,
   use the returned reject route to Check or Intake and preserve current documents.
5. Show the configured closing document in Markdown for authorized human review. Publish/submit
   only through returned normal gates; final human approval closes the Story. Automatic routing
   never approves, accepts risk or closes it on behalf of the user.
