<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

What one repository promises another, written down before either builds against it. This is the only
artifact two teams are both bound by, so it is specified rather than described: a consumer must be
able to build against this document without reading the producer's code.

## Contracts in this initiative

| ID | Contract | Producer | Consumers | Version | Format |
|---|---|---|---|---|---|
| C-1 | | | | 1 | OpenAPI / AsyncAPI / JSON Schema / protobuf / Markdown |

Producers and consumers are repository IDs the portfolio declares. A consumer named here that the
story plan does not touch is either a missing dependency or a stale row.

## C-1 — <contract name>

### Operations

| Operation | Direction | Purpose | Idempotent |
|---|---|---|---|

### Request

| Field | Type | Required | Constraints | Notes |
|---|---|---|---|---|

### Response

| Field | Type | Always present | Notes |
|---|---|---|---|

### Errors

Every error a consumer must handle. An error surface left undefined is handled by each consumer
differently, which is the defect this table prevents.

| Condition | Code | Retryable | What the consumer should do |
|---|---|---|---|

### Semantics

Ordering, idempotency, at-least-once versus exactly-once, and what a retry means. The parts that are
not visible in a schema and cause the most integration defects.

### Non-functional expectations

What the consumer may assume about the producer's behaviour under load.

| Expectation | Value | Measured where |
|---|---|---|
| p95 latency | | |
| Availability | | |
| Rate limit | | |

### Security

Authentication, authorisation, and what the producer assumes about the caller's identity.

## Compatibility

How this contract changes without breaking the repositories that depend on it.

| Policy | Value |
|---|---|
| Compatibility guarantee | backward / forward / none |
| How breaking changes ship | |
| Notice given to consumers | |
| Versions supported at once | |

## Sequencing

Which side lands first. A contract change that both sides must deploy simultaneously is a contract
change that will fail at least once.

| Change | Producer lands | Consumer lands | Safe to deploy independently |
|---|---|---|---|
| | | | yes / no |

## Verification

How both sides prove they honour this without integrating. A contract nobody tests is documentation.

| Contract | Producer test | Consumer test | Where it runs |
|---|---|---|---|

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
