<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

How well the system must behave, stated as numbers somebody can measure. "Fast", "secure" and
"scalable" are not requirements; they are the absence of one.

## Performance

| ID | Operation | Measure | Target | At load | Measured how |
|---|---|---|---|---|---|
| NFR-P1 | | p95 latency | | | |

## Capacity and growth

What the system must carry today and what it must still carry in a year. A target with no horizon
gets designed for today.

| Dimension | Today | At launch | In 12 months |
|---|---|---|---|

## Availability

| ID | Scope | Target | Measurement window | Planned downtime allowed |
|---|---|---|---|---|
| NFR-A1 | | | | |

## Recovery

What is promised after a failure, which is a different question from how often failure is allowed.

| Scenario | Recovery time | Data loss tolerated | Tested how |
|---|---|---|---|

## Security

| ID | Requirement | Applies to | Verified by |
|---|---|---|---|
| NFR-S1 | | | |

## Privacy and retention

| Data | Retention | Deletion trigger | Verified by |
|---|---|---|---|

## Observability

What must be emitted for the targets above to be provable in production. A target nobody can measure
after launch is not a commitment.

| Target | Signal | Emitted by | Alert threshold |
|---|---|---|---|

## Accessibility and localisation

| ID | Requirement | Standard | Verified by |
|---|---|---|---|

## Trade-offs accepted

Where one of these targets was relaxed to meet another, and who agreed.

| Relaxed | In favour of | Agreed by |
|---|---|---|

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
