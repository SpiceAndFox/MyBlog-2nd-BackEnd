ALTER TABLE chat_context_quality_diagnostics
  ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS chat_memory_diagnostic_projection_checkpoints (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  projection_key TEXT NOT NULL,
  processed_event_id BIGINT NOT NULL DEFAULT 0,
  last_error_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);
