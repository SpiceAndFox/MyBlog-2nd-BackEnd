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
- `support/`: small contract-focused builders shared across nearby suites.

Chat, RAG, server, security, LLM, and developer-tool tests live in their corresponding top-level `test/` directories rather than under Memory.

## Shared test data

Shared builders and cross-suite scenarios live under `support/`. Keep test-local inputs and expected values next to the assertions that use them. Byte-for-byte golden output stays beside its owning suite, such as `domain/golden/` for Renderer output.

Real Provider checks remain explicit networked commands and are not part of the offline suite:

- `npm run probe:memory-v2-provider`
- `npm run smoke:memory-v2-provider`
