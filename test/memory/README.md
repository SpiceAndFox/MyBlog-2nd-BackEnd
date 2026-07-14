# Memory Control v2 tests

`npm run test:memory-v2` is the single offline regression entry point. Test files are organized by stable architectural responsibility rather than implementation stage numbers.

## Boundaries

- `domain-*`, `context-coverage`, `memory-health`, `event-replay`, and `rag-suppression` exercise deterministic domain behavior.
- `normal-write-pipeline`, `provider-retry`, `task-idempotency`, `transaction-recovery`, `capacity-maintenance`, and `housekeeping` exercise application workflows and durable state transitions.
- `source-rebuild`, `projection-drain`, `privacy-hard-delete`, `retention`, `migration`, and `state-recovery` exercise recovery and lifecycle operations.
- `provider-*`, `deepseek-*`, and `structured-transport` exercise provider schemas and protocol adapters.
- `repository-behavior`, `schema-checker`, and `migration-schema` exercise persistence contracts without requiring a live database.

Reusable builders belong in `support/`. Keep helpers small and contract-focused; do not introduce a universal repository mock that hides transaction or persistence differences.

## Fixtures

Structured fixtures live under `modules/memory/harness/` and must declare one supported `fixtureKind`:

- `reducer`: executed by the deterministic reducer runner.
- `pipeline`: executed through the normal write pipeline fixture test.
- `context`: support data for context coverage and assembly scenarios.
- `recovery`: support data for durable recovery workflows.

Do not execute the same scenario both through the fixture runner and through a second hand-written test. Put generated-state, event, cursor, snapshot, and render expectations in the fixture when the runner can express them.

Real Provider checks are explicit networked commands and are not part of the offline suite:

- `npm run probe:memory-v2-provider`
- `npm run smoke:memory-v2-provider`
