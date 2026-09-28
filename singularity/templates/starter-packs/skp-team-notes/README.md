# SKP team notes starter

This starter is a reviewable, artifact-only Story workflow candidate:

`intake → skp-team-note → conformance`

The middle phase proposes the `skp-analysis-procedure` skill. It reads only the
approved intake artifact and writes one Markdown findings artifact. It has no
application-source read or write scope, operation bindings, external host, or
automatic approval. The requested producer classification is a **candidate for
local review**, not an approved skill or an execution grant.

Re-initialization installs this starter at
`singularity/templates/starter-packs/skp-team-notes/`. It does **not** alter the
repository's active `workTypes`, create a shared Git draft, approve a skill, or
repin any Story. It preserves a customized file at this path. This separation
keeps an unreviewed skill out of the Story workflow picker.

To use it, open the exact repository in Configuration Center → Shared workflow
drafts. First run Shell `singularity-flow workflow author list --json` (Copilot:
`/sf-workflows author list`) to obtain the exact current shared head. Then create
a shared draft from this starter's `draft-input.json`:

```sh
singularity-flow workflow author create WFD-SKPTEAM01 \
  --input singularity/templates/starter-packs/skp-team-notes/draft-input.json \
  --name "SKP team notes" --expected-head <HEAD-FROM-LIST-OR-empty> \
  --operation-id <NEW-UNIQUE-ID> --json
```

Copilot: `/sf-workflows author create` with the same draft ID and input. Choose
an unused `WFD-` ID and use `empty` only when the list returns a null head.

The input deliberately omits `baseRevision`. Bind the exact approved
configuration base returned by Preview in the draft editor, then save and
Preview again. Review the skill, agent, phase contract, output, and reviewer
authority for this repository. Submission requires a separate terminal consent
and creates only an inactive configuration proposal. Review and activate that
proposal separately; only then may the workflow appear in future Story intake.
Existing Stories keep their pinned workflow. SKP phase execution still refuses
until an approved host/runner can prove the required enforcement and delivery.
