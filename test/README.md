# Test layout

Tests are grouped first by the production subsystem they protect:

- `memory/`: Memory Control contracts, domain logic, workflows, providers, persistence, integrations, tools, and migration coverage.
- `chat/`: chat orchestration, scope coordination, context integration, and avatar storage.
- `rag/`: retrieval degradation and projection adapters.
- `llm/`: provider-independent LLM protocol adapters.
- `server/`: process and HTTP lifecycle behavior.
- `security/`: upload and raw-debug-data safety boundaries.
- `tools/`: developer-tool behavior.

`npm test` runs every offline test. Subsystem scripts are available for focused Memory, migration, Chat, and RAG runs. Networked Provider probes are not part of the default test suite.
