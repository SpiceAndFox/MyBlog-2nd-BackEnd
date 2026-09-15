BEGIN;

ALTER TABLE chat_message_gists ADD COLUMN IF NOT EXISTS source_hash TEXT;

CREATE TABLE IF NOT EXISTS chat_gist_tasks (
  message_id BIGINT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retry_wait','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_retry_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  run_token UUID,
  last_error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_gist_tasks_due
  ON chat_gist_tasks (status, next_retry_at, lease_until, updated_at)
  WHERE status IN ('queued','running','retry_wait');
CREATE INDEX IF NOT EXISTS idx_chat_gist_tasks_scope ON chat_gist_tasks(user_id,preset_id);

COMMIT;
