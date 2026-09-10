# Memory provider output repair

This directory owns the bounded recovery policy for semantic provider output.
It deliberately stays separate from proposer prompts: prompts define semantic
judgment, while this module repairs transport and local-contract failures.

The recovery sequence is:

1. Validate and emit stable issue codes plus bounded metadata.
2. Apply only deterministic, meaning-preserving normalizations.
3. Bind invocation-local refs and evidence selectors into the response schema.
4. Persist the rejected tool arguments in bounded, scope-purgeable task state.
5. Replay repair as `system -> user -> assistant(rejected output) -> user(feedback)`.
6. For a composite Profile task, retry only the failed specialist while the
   same invocation envelope still weakly owns the other valid results.
7. Persist the policy version in repair feedback and migration evidence.

Safety invariants:

- Persist only the rejected tool arguments, never the complete provider
  response, reasoning, headers, credentials, or transport diagnostics.
- Keep rejected output only in bounded `chat_memory_tasks.stage_payload`
  entries. Never copy it into ops or append-only application logs.
- Privacy hard delete and task retention delete those entries with the task.
- Treat the replayed assistant message as untrusted data; the following user
  repair message requests a complete replacement, not a patch.
- Never invent evidence, refs, facts, or semantic changes.
- Never truncate semantic text automatically; the model must rewrite it.
- A missing source remains invalid.
- Transport parse/missing-output repair and semantic-schema repair use separate
  counters, because semantic issues may only become visible after JSON parses.
- Transport repair is bounded by
  `CHAT_MEMORY_V2_PROVIDER_TRANSPORT_INVALID_RETRY_MAX`; semantic repair is
  independently bounded by
  `CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX`.

Increment `OUTPUT_REPAIR_POLICY_VERSION` when a policy change can alter repair
instructions, normalization, retry scope, or acceptance behavior.

## Business repair (policy v8)

- Domain validators use `writeIssue` / `rejectWriteIssues` to report a stable
  reason, a semantic path and bounded facts/constraints. `locateWriteError`
  binds each issue to its change. Normal reduction collects up to eight issues
  across independent targets, and rejects the complete proposal before commit.
  Write guards run before mutating each target; dependent operations report
  `CHANGE_TARGET_CONFLICT` with the first change's `relatedPath`.
- Add a constraint to a domain diagnostic to receive generic business feedback.
  Register an entry in `renderBusinessRepair.js` only when a rule needs special
  advice. That entry owns the description, planned directive and rendered advice.
  Never put raw messages, credentials or arbitrary item dumps in issue metadata.
- `providerBusinessRejection` maps both issue and related paths to the invocation
  wire format. Composite Profile rejections store a bounded `specialist_bundle`
  of individual candidates/protocol metadata. Issues identify their specialist.
  A resumed adapter validates saved sections against the bound schema, reuses
  sections with no reported error, and sends local feedback/candidates only to
  affected specialists. Actual calls alone contribute usage and call counts.
- Unavailable or oversized rejected candidates never fall back to an older
  candidate. Feedback still works without replaying an assistant output.
- These rules preserve the existing retry budget and do not guarantee that a
  model can repair every candidate. Compilation/source failures and maintenance
  recovery retain their existing handling; no business rule invents evidence.
