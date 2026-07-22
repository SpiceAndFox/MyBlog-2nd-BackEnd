# Test layout

Tests are grouped first by the production subsystem they protect:

- `architecture/`: local dependency direction, module-entry, and cycle gates.
- `memory/`: Memory Control contracts, domain logic, workflows, providers, persistence, integrations, tools, and migration coverage.
- `chat/`: chat orchestration, scope coordination, context integration, and avatar storage.
- `rag/`: retrieval degradation and projection adapters.
- `llm/`: provider-independent LLM protocol adapters.
- `server/`: process and HTTP lifecycle behavior.
- `security/`: upload and raw-debug-data safety boundaries.
- `tools/`: developer-tool behavior.
- `tmp/`: still-enforced characterization tests tied to legacy boundaries; each file documents a replacement/removal trigger in `tmp/README.md`.

`npm test` is the complete offline gate: it runs `npm run check:architecture` and then every offline test. Subsystem scripts are available for focused Memory, migration, Chat, and RAG runs. Networked Provider probes, database migrations, and live-service smoke checks are not part of the default test suite.
