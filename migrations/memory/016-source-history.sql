BEGIN;

-- A complete chain of source transitions is required before an older generation
-- can be used as a recovery point. Do not backfill guesses for legacy changes.
CREATE TABLE IF NOT EXISTS chat_memory_source_history (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL CHECK (source_generation > 0),
  affected_from_message_id BIGINT CHECK (affected_from_message_id > 0),
  source_unchanged BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, source_generation)
);

COMMIT;
