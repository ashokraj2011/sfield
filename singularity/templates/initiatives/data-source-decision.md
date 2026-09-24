<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

Where test data will come from, decided deliberately. The default — a copy of production — is the
option with the most obligations attached, and taking it by accident is how those obligations get
missed.

## Decision

The chosen source, in one line, with the date and who decided.

## Options considered

| Option | Realism | Effort | Obligations it creates | Chosen |
|---|---|---|---|---|
| Synthetic | low | | none | |
| Masked production copy | high | | data protection, retention | |
| Subsetted production | high | | data protection, referential integrity | |
| Manually curated | medium | | maintenance | |

## Why

The reasoning, including what was traded away.

## If production data is used

Only complete this section if it is. An empty section here is a much better signal than a
half-completed one.

| Question | Answer |
|---|---|
| Which fields are masked | |
| Masking verified by | |
| Where the copy may live | |
| Who may access it | |
| Retention and deletion | |
| Approved by | |

## Referential integrity

Whether related records stay consistent across systems, and what breaks if they do not.

## Refresh

Who refreshes, how often, and what the process is when it drifts.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
