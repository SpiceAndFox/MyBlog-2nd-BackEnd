# Test layout

Tests are grouped first by the production subsystem they protect:

- `architecture/`: local dependency direction, module-entry, and cycle gates.
- `memory/`: Memory Control contracts, domain logic, workflows, providers, persistence, integrations, tools, and migration coverage.
- `chat/`: chat orchestration, scope coordination, context integration, and avatar storage.
- `llm/`: provider-independent LLM protocol adapters.
- `server/`: process and HTTP lifecycle behavior.
- `security/`: upload and raw-debug-data safety boundaries.
- `tools/`: developer-tool behavior.
- `tmp/`: still-enforced characterization tests tied to legacy boundaries; each file documents a replacement/removal trigger in `tmp/README.md`.

`npm test` is the complete offline gate: it runs `npm run check:architecture` and then every offline test. Subsystem scripts are available for focused Memory, migration, and Chat runs. Networked Provider probes, database migrations, and live-service smoke checks are not part of the default test suite.

## Assertion policy

Tests protect observable behavior and durable contracts, not incidental implementation shape:

- Keep exact assertions for public HTTP contracts, persisted schemas and versions, security/privacy boundaries, transaction semantics, and stable machine protocols.
- Assert only the fields relevant to a behavior when inspecting internal diagnostic objects; adding unrelated fields must not break a test.
- Prompt contract tests may require schema-owned field names, section ownership, and safety boundaries, but must not freeze headings, examples, prose, length, or editorial organization.
- Temporary migration and compatibility guards must document a retirement condition.
