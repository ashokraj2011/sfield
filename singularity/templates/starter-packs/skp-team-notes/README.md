# SKP team notes starter

This starter is a reviewable, artifact-only Story workflow candidate:

`intake → skp-team-note → skp-team-review`

The middle phase proposes the `skp-analysis-procedure` skill. It reads only the
approved intake artifact and writes one Markdown findings artifact. The final
phase reads the approved intake and note, writes a review record, and waits for
human approval to finish the Story. Its record is context for the reviewer, not
an approval receipt. A reviewer may return the note for up to three correction
attempts. Neither phase reads or writes application source or asks
for external operations or a host. The requested producer classification is a
**candidate for local review**, not an approved skill or an execution grant.

Re-initialization installs this starter at
`singularity/templates/starter-packs/skp-team-notes/`. It does **not** alter the
repository's active `workTypes`, create a shared Git draft, approve a skill, or
repin any Story. It preserves a customized file at this path. This separation
keeps an unreviewed skill out of the Story workflow picker.

Before submitting, make the selected repository's approved reviewer policy
attainable. Fresh packaged defaults have empty `product-approvers.members`, so
they cannot complete Intake or either new phase. Add at least one eligible
reviewer's Git email or GitHub login to that authority through the repository's
normal configuration review, then bind this draft to the new approved base.
If the repository uses different Intake reviewers, configure those too. Preview
reports missing reviewer capacity; the starter does not enroll or approve
anyone.

To use it, open the exact repository in Configuration Center → Shared workflow
drafts. First run Shell `singularity-flow workflow author list --json` (Copilot:
`/sf-workflows author list`) to obtain the exact current shared head. Then create
a shared draft from this starter's `draft-input.json`:

```sh
singularity-flow workflow author create WFD-SKPTEAM01 \
  --input @approved-starter/skp-team-notes \
  --name "SKP team notes" --expected-head empty \
  --operation-id skp-starter-create-001 --json
```

Copilot: `/sf-workflows author create` with the same draft ID and input. Choose
an unused `WFD-` ID and new operation ID; replace `empty` with the exact returned
Git object ID when the list reports a non-null head.
The `@approved-starter` selector reads this file from the freshly verified
approved configuration authority; it does not require the application checkout
to contain `singularity/` or write a local copy.

The input deliberately omits `baseRevision`. Bind the exact approved
configuration base returned by Preview in the draft editor, then save and
Preview again. Review both agents, the skill, both phase contracts, their
outputs, and reviewer authority for this repository. Submission requires a
separate terminal consent and creates only an inactive configuration proposal.
Review and activate that proposal separately; only then may the workflow
appear in future Story intake. Existing Stories keep their pinned workflow.
SKP phase execution still refuses until an approved host/runner can prove the
required enforcement and delivery.
