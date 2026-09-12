BEGIN;

-- Apply after deploying the runtime without retrieval/indexing workers.
-- Shared Memory diagnostics and notifications keep their other subjects.
DELETE FROM chat_context_quality_diagnostics
WHERE subject_kind='projection' AND subject_key='rag';

DELETE FROM chat_memory_recovery_notifications
WHERE subject_kind='projection' AND subject_key='rag';

DROP TABLE IF EXISTS chat_rag_projection_staging;
DROP TABLE IF EXISTS chat_rag_chunks;
DROP TABLE IF EXISTS chat_context_projection_checkpoints;

-- The optional pgvector extension cleanup requires its owner and lives in
-- migrations/optional/retire-pgvector.sql. No runtime depends on that extension.

COMMIT;
