<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

What was proved technically, and what the proof is worth. The value of a spike is the uncertainty it
removes from the architecture — so the result is stated against the architectural decision it was
run to settle.

## Decision it informs

Which ADR or design choice this was run for. A spike with no decision waiting on it was exploration,
and should be labelled as such.

## Hypothesis

What was expected before it was run, so the result can be compared against it rather than
rationalised after.

## What was built and measured

| Aspect | This spike | Production would need |
|---|---|---|

## Method

Environment, data, scale, duration, and what was stubbed. A number without these is not reusable.

## Results

| # | Measure | Expected | Observed | Verdict |
|---|---|---|---|---|
| 1 | | | | met / missed |

## What it did not establish

Load not reached, conditions not tried, components substituted. The section that stops a spike being
cited as a production guarantee.

## Effect on the architecture

What changes as a result — the decision confirmed, revised, or reversed.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
