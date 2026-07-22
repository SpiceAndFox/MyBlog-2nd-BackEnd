BEGIN;

ALTER TABLE chat_memory_snapshots
  ALTER COLUMN schema_version TYPE TEXT USING schema_version::TEXT;

ALTER TABLE chat_memory_event_groups
  ALTER COLUMN schema_version TYPE TEXT USING schema_version::TEXT;

ALTER TABLE chat_memory_tasks
  ADD COLUMN IF NOT EXISTS schema_version TEXT;

UPDATE chat_memory_tasks
SET schema_version = COALESCE(task_payload #>> '{task,schemaVersion}', 'legacy')
WHERE schema_version IS NULL;

ALTER TABLE chat_memory_tasks
  ALTER COLUMN schema_version SET NOT NULL;

COMMIT;
