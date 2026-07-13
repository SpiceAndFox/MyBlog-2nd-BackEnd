BEGIN;

ALTER TABLE chat_context_quality_diagnostics
  ADD COLUMN IF NOT EXISTS source_generation BIGINT;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id,preset_id,subject_kind,subject_key,diagnostic_type
    ORDER BY updated_at DESC,id DESC
  ) AS position
  FROM chat_context_quality_diagnostics
  WHERE resolved=FALSE
)
UPDATE chat_context_quality_diagnostics d
SET resolved=TRUE,resolved_at=NOW(),updated_at=NOW()
FROM ranked r
WHERE d.id=r.id AND r.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_diagnostics_one_active
  ON chat_context_quality_diagnostics(user_id,preset_id,subject_kind,subject_key,diagnostic_type)
  WHERE resolved=FALSE;

ALTER TABLE chat_context_projection_checkpoints
  ADD COLUMN IF NOT EXISTS processed_tombstone_id BIGINT NOT NULL DEFAULT 0;

COMMIT;
