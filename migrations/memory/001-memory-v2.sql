BEGIN;

CREATE TABLE IF NOT EXISTS chat_preset_memory (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset_id VARCHAR(64) NOT NULL,
  memory_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id),
  CONSTRAINT fk_chat_preset_memory_preset
    FOREIGN KEY (user_id, preset_id)
    REFERENCES chat_prompt_presets(user_id, preset_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

ALTER TABLE chat_preset_memory ADD COLUMN IF NOT EXISTS memory_state JSONB;
CREATE INDEX IF NOT EXISTS idx_chat_preset_memory_user_preset ON chat_preset_memory(user_id, preset_id);
CREATE INDEX IF NOT EXISTS idx_chat_preset_memory_user_updated_at ON chat_preset_memory(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_memory_snapshots (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL, revision BIGINT NOT NULL, schema_version INTEGER NOT NULL,
  state JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, revision)
);

CREATE TABLE IF NOT EXISTS chat_memory_event_groups (
  event_group_id UUID PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, task_id UUID NOT NULL,
  target_key TEXT NOT NULL, source_generation BIGINT NOT NULL, schema_version INTEGER NOT NULL,
  base_revision BIGINT NOT NULL, result_revision BIGINT, cursor_before BIGINT, cursor_after BIGINT,
  group_kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, result_revision)
);

CREATE TABLE IF NOT EXISTS chat_memory_events (
  id BIGSERIAL PRIMARY KEY, event_group_id UUID NOT NULL REFERENCES chat_memory_event_groups(event_group_id),
  event_index INTEGER NOT NULL, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, task_id UUID NOT NULL,
  tick_id BIGINT, target_key TEXT NOT NULL, section TEXT NOT NULL, event_kind TEXT NOT NULL,
  decision TEXT NOT NULL, patch_id TEXT, op TEXT, item_id TEXT, result_item_id TEXT,
  merged_from_item_ids JSONB, evidence_kind TEXT, reject_reason TEXT, maintenance_task_id UUID,
  patch_summary JSONB, normalized_operation JSONB, cleanup_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_events_user_preset ON chat_memory_events(user_id, preset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_target_decision ON chat_memory_events(user_id, preset_id, target_key, decision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_group_order ON chat_memory_events(event_group_id, event_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_group_patch ON chat_memory_events(event_group_id, patch_id) WHERE patch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_memory_tasks (
  task_id UUID PRIMARY KEY, dedupe_key TEXT NOT NULL, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL,
  target_key TEXT NOT NULL, source_generation BIGINT NOT NULL, task_type TEXT NOT NULL,
  parent_task_id UUID, predecessor_task_id UUID, resume_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, stage TEXT NOT NULL, cursor_before BIGINT, target_message_id BIGINT,
  base_revision BIGINT NOT NULL, task_payload JSONB NOT NULL, stage_payload JSONB,
  attempt INTEGER NOT NULL DEFAULT 0, context_expansion_attempt INTEGER NOT NULL DEFAULT 0,
  not_before TIMESTAMPTZ, last_error_reason TEXT, result_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_tasks_recovery ON chat_memory_tasks(status, not_before, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tasks_scope_dedupe ON chat_memory_tasks(user_id, preset_id, dedupe_key);

CREATE TABLE IF NOT EXISTS chat_memory_target_status (
  user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, target_key TEXT NOT NULL,
  source_generation BIGINT NOT NULL, rebuild_boundary_message_id BIGINT, status TEXT NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0, last_error_reason TEXT, last_task_id UUID,
  next_retry_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, target_key)
);

CREATE TABLE IF NOT EXISTS chat_memory_ops_log (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL, task_id UUID NOT NULL, tick_id BIGINT, target_key TEXT NOT NULL,
  section TEXT, proposer TEXT, outcome TEXT NOT NULL, attempt INTEGER NOT NULL, detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_ops_log_health ON chat_memory_ops_log(user_id, preset_id, target_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_ops_log_outcome ON chat_memory_ops_log(user_id, preset_id, outcome, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_context_projection_checkpoints (
  user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, projection_key TEXT NOT NULL,
  processed_generation BIGINT NOT NULL, processed_boundary_message_id BIGINT, status TEXT NOT NULL,
  last_error_reason TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);

CREATE TABLE IF NOT EXISTS chat_context_suppression_tombstones (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL, reason TEXT NOT NULL, source_item_id TEXT, source_section TEXT,
  created_revision BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, message_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_suppression_tombstones_lookup ON chat_context_suppression_tombstones(user_id, preset_id, message_id);

CREATE TABLE IF NOT EXISTS chat_context_quality_diagnostics (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL, diagnostic_type TEXT NOT NULL, request_id TEXT, target_cursor BIGINT,
  processed_boundary_message_id BIGINT, omitted_upper_message_id BIGINT, recent_window_start BIGINT,
  original_gap_count INTEGER, original_gap_chars INTEGER, retained_boundary BIGINT, retained_count INTEGER,
  omitted_count INTEGER, omitted_chars INTEGER, truncated BOOLEAN NOT NULL DEFAULT FALSE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE, resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_context_diagnostics_active ON chat_context_quality_diagnostics(user_id, preset_id, subject_kind, subject_key, resolved, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_memory_recovery_notifications (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, preset_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL, notification_type TEXT NOT NULL, boundary_message_id BIGINT NOT NULL DEFAULT 0,
  source_generation BIGINT NOT NULL, delivered BOOLEAN NOT NULL DEFAULT FALSE, delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, subject_kind, subject_key, notification_type, source_generation, boundary_message_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_notifications_pending ON chat_memory_recovery_notifications(user_id, preset_id, delivered, created_at DESC);

COMMIT;
