BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'UTC';

-- Preserve the deterministic semantics of durable tasks created before this
-- field existed. Only non-terminal payloads can execute after the deployment.
UPDATE chat_memory_tasks AS task
SET task_payload = jsonb_set(task.task_payload, '{task,userTimeZone}', to_jsonb(users.time_zone), true)
FROM users
WHERE users.id = task.user_id
  AND task.status IN ('queued', 'running', 'retry_wait')
  AND NOT (task.task_payload->'task' ? 'userTimeZone');

COMMIT;
