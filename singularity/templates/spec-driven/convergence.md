# Convergence — {{work.id}}

The pre-verification closure loop at requirement altitude `[SPK:CON-038]`. This document is the human
narrative; `convergence.json` is the authoritative projection `[SPK:REQ-080]`.

Convergence consumes reconciliation's output rather than re-deriving it — it never re-enumerates or
reclassifies changed paths `[SPK:CON-032]`.

## Iteration

Which iteration this is, and what changed since the last one.

## Deterministic facts

Facts the kernel derived without a model `[SPK:REQ-074]`. An absent claim is missing *trace evidence*,
not proof that implementation is missing `[SPK:CON-033]` — the wording matters, because one is a
record-keeping gap and the other is an accusation.

## Findings and dispositions

Every finding carries a human disposition: `rework`, `accepted-deviation`, `dismissed`, or
`deferred`, with a reason `[SPK:REQ-079]`.

| Finding | Clauses | Disposition | Reason |
|---|---|---|---|

## Unresolved blockers

Advancement to verification fails while any remain `[SPK:REQ-183]`.
