# Memory provider output repair

This directory owns the bounded recovery policy for semantic provider output.
It deliberately stays separate from proposer prompts: prompts define semantic
judgment, while this module repairs transport and local-contract failures.

The recovery sequence is:

1. Validate and emit stable issue codes plus bounded metadata.
2. Apply only deterministic, meaning-preserving normalizations.
3. Bind invocation-local refs and evidence selectors into the response schema.
4. Persist repair candidates in bounded, scope-purgeable task state.
5. Replay repair as `system -> user -> assistant(rejected output) -> user(feedback)`.
6. For a composite Profile task, persist each specialist's candidate and pending
   feedback, and reuse valid siblings across retries and process restarts.
7. Persist the policy version in repair feedback and migration evidence.

Safety invariants:

- Persist only output candidates and bounded repair/protocol metadata, never the
  complete provider response, reasoning, headers, credentials, or transport diagnostics.
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

## Business and composite repair (policy v9)

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
  wire format. Composite Profile output-repair failures store a bounded
  `specialist_bundle` of individual candidates, protocol metadata and pending
  feedback. This state is independent of whether the latest failure is business,
  wire schema, semantic, invalid/incomplete JSON or missing output. Each failed
  specialist retains its own feedback, including when several fail together.
- A resumed adapter checks the bundle's task/input fingerprint (independent of
  JSON object key order, preserving array order) and validates
  saved sections against the current bound schema and semantic contract. Only
  sections with no pending error can be reused. A structurally valid candidate
  rejected by business rules still requires repair. Each affected specialist
  receives only its own candidate and feedback; actual calls alone contribute
  usage and call counts. The merged proposal still passes business preflight
  before an atomic commit.
- Older task-local business bundles remain readable and undergo bound validation.
  Historical failures that saved only one specialist's output cannot recover
  sibling candidates that were never persisted. The WeakMap remains a fallback
  for older callers; new durable bundles are authoritative.
- Unavailable or oversized rejected candidates never fall back to an older
  candidate. Feedback still works without replaying an assistant output.
- These rules preserve the existing retry budget and do not guarantee that a
  model can repair every candidate. Compilation/source failures and maintenance
  recovery retain their existing handling; no business rule invents evidence.
