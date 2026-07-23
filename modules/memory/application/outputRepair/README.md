# Memory provider output repair

This directory owns the bounded recovery policy for semantic provider output.
It deliberately stays separate from proposer prompts: prompts define semantic
judgment, while this module repairs transport and local-contract failures.

The recovery sequence is:

1. Validate and emit stable issue codes plus bounded metadata.
2. Apply only deterministic, meaning-preserving normalizations.
3. Bind invocation-local refs and evidence selectors into the response schema.
4. Build one positive, issue-specific replacement instruction.
5. For a composite Profile task, retry only the failed specialist while the
   same invocation envelope still weakly owns the other valid results.
6. Persist the policy version in repair feedback and migration evidence.

Safety invariants:

- Never copy the rejected raw output into prompts, durable state, or logs.
- Never invent evidence, refs, facts, or semantic changes.
- Never truncate semantic text automatically; the model must rewrite it.
- A missing source remains invalid.
- Retry counts remain bounded by the pipeline recovery configuration.

Increment `OUTPUT_REPAIR_POLICY_VERSION` when a policy change can alter repair
instructions, normalization, retry scope, or acceptance behavior.
