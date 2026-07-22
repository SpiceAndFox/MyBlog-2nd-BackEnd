# Memory Control v2 tests

`npm run test:memory-v2` is the offline Memory regression entry point. Tests mirror the stable architecture instead of implementation stages:

- `contracts/`: configuration, state/Semantic contracts, due dates, and proposer prompt protocol.
- `domain/`: deterministic lifecycle, rendering, context coverage, health, and event replay.
- `application/`: durable workflows, recovery, capacity, projections, privacy, and runtime coordination.
- `providers/`: structured-output schemas, adapters, preflight, and transport behavior.
- `persistence/`: repository contracts exercised with explicit fake clients.
- `integration/`: multi-layer vertical slices across renderer, Provider adapter, Compiler, Reducer, and persistence.
- `tools/`: read-only inspection, rebuild, and shadow-replay tooling.
- `migration/`: time-bounded schema, cutover, telemetry, and migration workflow coverage. Its retirement gate is documented in `migration/README.md`.
- `harness/`: fixture catalog and deterministic fixture-runner coverage.
- `support/`: small contract-focused builders shared across nearby suites.

Chat, RAG, server, security, LLM, and developer-tool tests live in their corresponding top-level `test/` directories rather than under Memory.

## Fixtures

Structured fixtures live under `modules/memory/harness/` and declare one implemented `fixtureKind`:

- `compiledReducer`: validated and executed by the deterministic reducer runner.
- `context`: validated catalog data consumed by context tests.
- `recovery`: validated catalog data consumed by explicit durable workflow harnesses.

Do not execute the same behavior through both a fixture runner and a hand-written test. Put generated state, events, cursors, snapshots, and render expectations in a fixture when its runner can express them.

Real Provider checks remain explicit networked commands and are not part of the offline suite:

- `npm run probe:memory-v2-provider`
- `npm run smoke:memory-v2-provider`
