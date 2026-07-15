BEGIN;

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS turn_id UUID;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS parent_user_message_id BIGINT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS source_generation BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_parent_user'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT fk_chat_messages_parent_user
      FOREIGN KEY (parent_user_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_scope_idempotency
  ON chat_messages(user_id, preset_id, idempotency_key)
  WHERE role = 'user' AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_one_assistant_per_parent
  ON chat_messages(parent_user_message_id)
  WHERE role = 'assistant' AND parent_user_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages(turn_id);

ALTER TABLE chat_memory_privacy_operations
  ADD COLUMN IF NOT EXISTS operation_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE chat_memory_privacy_operations
  DROP CONSTRAINT IF EXISTS chat_memory_privacy_operations_pkey;
ALTER TABLE chat_memory_privacy_operations
  ADD CONSTRAINT chat_memory_privacy_operations_pkey PRIMARY KEY (operation_id);
DROP INDEX IF EXISTS idx_memory_privacy_operations_operation_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_privacy_operations_active_scope
  ON chat_memory_privacy_operations(user_id,preset_id) WHERE status <> 'completed';

COMMIT;
