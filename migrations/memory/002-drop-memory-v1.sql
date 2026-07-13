BEGIN;

DROP TABLE IF EXISTS chat_preset_memory_checkpoints;

ALTER TABLE chat_preset_memory
  DROP COLUMN IF EXISTS rolling_summary,
  DROP COLUMN IF EXISTS rolling_summary_updated_at,
  DROP COLUMN IF EXISTS summarized_until_message_id,
  DROP COLUMN IF EXISTS dirty_since_message_id,
  DROP COLUMN IF EXISTS rebuild_required,
  DROP COLUMN IF EXISTS core_memory;

COMMIT;
