BEGIN;

-- 013 also supports fresh databases; upgrade checkpoints created before the
-- persisted complete-turn/message-batch scheduling contract was introduced.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'chat_memory_librarian_checkpoints'
      AND column_name = 'completed_turn_ordinal'
  ) THEN
    ALTER TABLE chat_memory_librarian_checkpoints
      RENAME COLUMN completed_turn_ordinal TO completed_ordinal;
  END IF;
END $$;

ALTER TABLE chat_memory_librarian_checkpoints
  ADD COLUMN IF NOT EXISTS watermark_kind TEXT NOT NULL DEFAULT 'complete_turn',
  ADD COLUMN IF NOT EXISTS rebuild_schedule JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'chat_memory_librarian_checkpoints'::regclass
      AND conname = 'chk_memory_librarian_watermark_kind'
  ) THEN
    ALTER TABLE chat_memory_librarian_checkpoints
      ADD CONSTRAINT chk_memory_librarian_watermark_kind
      CHECK (watermark_kind IN ('complete_turn', 'message_batch'));
  END IF;
END $$;

COMMIT;
