BEGIN;

CREATE TABLE IF NOT EXISTS chat_memory_privacy_operations (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  operation_id UUID NOT NULL,
  operation_mode TEXT NOT NULL,
  source_generation BIGINT,
  boundary_message_id BIGINT,
  status TEXT NOT NULL,
  last_error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_privacy_operations_pending
  ON chat_memory_privacy_operations(status, updated_at)
  WHERE status <> 'completed';

COMMIT;
