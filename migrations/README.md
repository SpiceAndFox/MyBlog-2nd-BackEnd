# RAG retirement

For an existing database, stop every old Chat server and indexing command, deploy
the runtime without RAG, then apply only `memory/015-retire-chat-rag.sql` before
starting the new server. The normal Memory schema runner replays every migration;
it is not needed just to retire RAG on an already migrated database.

The retirement transaction drops `chat_rag_chunks`,
`chat_rag_projection_staging`, and `chat_context_projection_checkpoints`.
It deletes only the `projection/rag` subjects from shared diagnostics and recovery
notifications. Chat messages, Memory authority/history, assistant gists, and
`chat_memory_diagnostic_projection_checkpoints` remain intact.

The application role can remove its tables without owning the `vector` extension.
Afterward, the extension owner can apply `optional/retire-pgvector.sql` to remove
the unused extension. That command uses `RESTRICT`: another consumer blocks the
drop rather than losing its columns. Extension removal is optional for the app;
no runtime or fresh installation requires pgvector.

Earlier Memory migrations retain their historical checkpoint changes for replay.
Migration 015 removes that temporary schema again at the end of a full run.
