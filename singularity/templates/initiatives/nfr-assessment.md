<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

Whether the non-functional targets were actually met, measured rather than asserted. The
specification said what was required; this says what was observed, and the two columns sit next to
each other on purpose.

## Results

| ID | Requirement | Target | Observed | Verdict | Measured how |
|---|---|---|---|---|---|
| NFR-P1 | | | | met / missed / not measured | |

"Not measured" is a legitimate verdict and a more useful one than a blank. It says the commitment
exists and nobody checked.

## Conditions of measurement

Environment, data volume, load profile and duration. A latency figure without these is not
comparable to the target it is being checked against.

## Missed targets

| ID | Target | Observed | Cause | Disposition | Accepted by |
|---|---|---|---|---|---|
| | | | | fix now / fix later / accept | |

## Security verification

| Requirement | Verified by | Date | Result |
|---|---|---|---|

## Observability in place

Whether the signals the specification required are actually being emitted, since that is what makes
these targets checkable after release.

| Target | Signal | Emitting | Alerting |
|---|---|---|---|
| | | yes / no | yes / no |

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
