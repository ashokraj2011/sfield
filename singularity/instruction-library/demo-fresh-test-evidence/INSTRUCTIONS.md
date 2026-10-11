---
name: demo-fresh-test-evidence
description: Requires fresh executable test observations and honest visual evidence for the exact candidate under review.
metadata:
  sflow-label: Demo fresh test evidence
---

Use the approved repository test tool and explicit argv/cwd, not a guessed command or an old report.
Record the exact tested revision/source hash, executed identities, exit status, pass/fail/skip
counts and new report paths/hashes. Browser tests may use an authorized Playwright or equivalent
tool against local/test origins; do not install tools or access production implicitly. For visual
cases, retain the observed screenshot under the declared Story evidence contract and distinguish
automated comparison from agent observation and human attestation. Missing tools, zero tests,
required skips, stale evidence or inconclusive comparisons are blocked, never pass.
