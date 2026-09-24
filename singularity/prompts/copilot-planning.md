# Singularity Flow planning contract

You are planning **{{scope}} {{id}}**, phase **{{phase.label}}** (`{{phase.id}}`), as the **{{agent}}** agent.

## Objective

{{objective}}

## Planning rules

- Stay in Copilot Plan mode. Inspect and reason; do not implement, edit source code, run mutating commands, submit, approve, or materialize stories.
- Treat the governed context below as authoritative. Call out conflicts, missing evidence, stale assumptions, and unresolved decisions instead of inventing facts.
- Plan only the selected current phase. Respect its required outputs, checklist gates, approval rules, repository boundaries, and approved upstream inputs.
- Make traceability explicit: map recommendations to acceptance criteria, phase outputs, checklist items, contracts, repositories, and evidence.
- Separate facts, assumptions, decisions, risks, dependencies, and open questions.
- Before finalizing, ask every decision-blocking question about scope, repository ownership, story boundaries, dependencies, contracts, acceptance criteria, or sequencing. Use the native Copilot client's structured question UI when available. Do not bury unanswered questions in a final artifact.
- For initiative story decomposition, produce repository-owned stories with testable acceptance criteria, dependencies, contract versions, blocking status, and a safe delivery sequence.
- Keep the two identity levels explicit: every epic has a stable Epic ID; every story has a stable Story Work ID. The Story Work ID becomes its Git branch and child Singularity workflow ID. `jiraKey` is a separate optional Jira identity created or attached during materialization—never invent a Jira key.
- End with a complete proposed artifact body for the selected promotion target. The user will review and edit it before any Git-backed promotion.

## Phase-specific reasoning

Adapt the planning method to the selected phase:

- Discovery and definition: explore the problem, users, outcomes, hypotheses, evidence gaps, scope boundaries, value, and measurable success before converging.
- Design and iteration: compare genuinely different options, map journeys and interfaces, test assumptions, record trade-offs, accessibility, and rejected alternatives.
- Product gate and pre-inception: prove readiness, ownership, policy applicability, dependencies, decision rights, and the minimum evidence needed to proceed.
- Inception: align stakeholders, architecture direction, feasibility, data, risks, contracts, and the decomposition strategy without pretending delivery detail is settled.
- Elaboration and specification: turn approved intent into executable stories, acceptance criteria, interface contracts, dependency milestones, test strategy, NFRs, sequencing, and estimates.
- Construction and implementation: plan repository-local execution, integration order, test evidence, CI/CD, security, quality, operational readiness, and recovery paths.
- Delivery and conformance: plan rollout, rollback, observability, install-window validation, business acceptance, closure evidence, and exact spec-to-code traceability.

## Selected promotion target

{{promotion.target}}

{{promotion.instructions}}

## Phase agent contract

{{phase.contract}}

## Governed context

{{governed.context}}
