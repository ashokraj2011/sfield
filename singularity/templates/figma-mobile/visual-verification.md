# {{work.id}} — Mobile Visual Comparison

## Approved references and implementation

{{inputs}}

## Verification environment

| Field | Value |
|---|---|
| Source commit/tree hash | TODO |
| Platform/framework | TODO |
| Build configuration | TODO |
| Simulator/emulator devices | TODO |
| Locale, theme, text scale | TODO |
| Capture and comparison commands | TODO |
| Pixel/visual difference | TODO: record a numeric percentage, for example `Pixel diff: 1.8% — matched within threshold` |

## Screen comparison

| Screen/state | Design reference | App screenshot | Overlay/diff | Functional result | Visual result | Verdict |
|---|---|---|---|---|---|---|
| SCREEN-001 | DOC-nnn / path | TODO | TODO | pass/fail | TODO | matched/partial/missing/deviated |

Store implementation screenshots and pixelmatch/overlay diff images inside `artifacts/visual-verification/evidence/`. Use descriptive names such as `checkout-actual.png` and `checkout-pixelmatch-diff.png`. `singularity-flow phase publish visual-verification` automatically registers, hashes, commits, and pushes every changed file under this phase directory.

The VS Code Inbox and artifact viewer present the pinned design export,
implementation screenshot, and diff evidence together. Approval is always against
the registered pinned hashes, not the live Figma URL.

## Design-system and accessibility checks

| Check | Command/method | Result | Evidence |
|---|---|---|---|
| Component/token reuse | TODO | pass/fail | TODO |
| Semantic accessibility | TODO | pass/fail | TODO |
| Text scaling/localization | TODO | pass/fail | TODO |
| Keyboard/insets/orientation | TODO | pass/fail | TODO |

## Differences and dispositions

| Difference ID | Screen/spec | Observation | Severity | Fix/deviation | Approver |
|---|---|---|---|---|---|
| DIFF-001 | TODO | TODO | TODO | TODO | TODO |

## Conclusion

TODO: State which flows are visually and functionally ready, which remain partial or blocked, and whether designer and QA approval is recommended.
