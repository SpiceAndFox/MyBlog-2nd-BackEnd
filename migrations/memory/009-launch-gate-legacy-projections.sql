BEGIN;

-- Recall/Scene Recall is query-time enrichment and inherits the RAG cutoff.
-- Early v2 builds persisted a separate `recall` checkpoint and health rows;
-- remove that derived legacy state before enforcing the current contract.
DELETE FROM chat_context_quality_diagnostics
WHERE subject_kind='projection' AND subject_key<>'rag';

DELETE FROM chat_memory_recovery_notifications
WHERE subject_kind='projection' AND subject_key<>'rag';

DELETE FROM chat_context_projection_checkpoints
WHERE projection_key<>'rag';

ALTER TABLE chat_context_projection_checkpoints
  DROP CONSTRAINT IF EXISTS chk_context_projection_key;

ALTER TABLE chat_context_projection_checkpoints
  ADD CONSTRAINT chk_context_projection_key CHECK (projection_key='rag');

COMMIT;
