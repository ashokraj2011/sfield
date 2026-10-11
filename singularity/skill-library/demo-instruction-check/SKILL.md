---
name: demo-instruction-check
description: Independently tests current code against pinned sources and chooses an evidence-backed route with three placed reusable instructions.
metadata:
  sflow-label: Demo instruction-composed check
  sflow-instructions: [demo-source-interpretation, demo-fresh-test-evidence, demo-reviewed-routing]
---

## 1. Establish expected behavior

Read the approved intake and pinned source inventory before inspecting current behavior. On
retest, use the current repaired revision and retained repair receipt, never the first report.
<!-- sflow-instruction: demo-source-interpretation -->

## 2. Execute and compare

Run the approved tests. If screenshot scenarios apply, compare the observed current UI to the
approved visual contract; otherwise use the documented executable assertions.
<!-- sflow-instruction: demo-fresh-test-evidence -->

## 3. Report and propose a route

Fill every scenario row with actual evidence and limitations. Do not edit source, assertions or
reference images in this phase. Present the verdict for human review and closing or repair.
<!-- sflow-instruction: demo-reviewed-routing -->
