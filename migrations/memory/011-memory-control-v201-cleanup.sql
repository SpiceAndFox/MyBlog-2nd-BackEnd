BEGIN;

ALTER TABLE chat_memory_events DROP COLUMN IF EXISTS evidence_kind;
ALTER TABLE chat_context_projection_checkpoints DROP COLUMN IF EXISTS processed_tombstone_id;
DROP TABLE IF EXISTS chat_context_suppression_tombstones;

COMMIT;
