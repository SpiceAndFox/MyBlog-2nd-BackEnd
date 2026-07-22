const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the v1 schema removal migration drops only obsolete Memory storage", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/002-drop-memory-v1.sql"), "utf8");
  assert.match(sql, /DROP TABLE IF EXISTS chat_preset_memory_checkpoints/i);
  for (const column of ["rolling_summary", "core_memory", "dirty_since_message_id", "rebuild_required"]) {
    assert.match(sql, new RegExp(`DROP COLUMN IF EXISTS ${column}`, "i"));
  }
  assert.doesNotMatch(sql, /(?:DELETE FROM|UPDATE|DROP TABLE(?: IF EXISTS)?)\s+chat_messages\b/i);
});

test("User time-zone migration backfills non-terminal immutable task payloads", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/003-add-user-time-zone.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'UTC'/i);
  assert.match(sql, /jsonb_set\(task\.task_payload, '\{task,userTimeZone\}'/i);
  assert.match(sql, /task\.status IN \('queued', 'running', 'retry_wait'\)/i);
});

test("diagnostic projection migration adds generic detail and a durable event checkpoint", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/004-add-diagnostic-projection-checkpoints.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_memory_diagnostic_projection_checkpoints/i);
  assert.match(sql, /processed_event_id BIGINT NOT NULL DEFAULT 0/i);
});

test("fresh RAG schema includes the embedding text required by the v2 projection adapter", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../../models/tableCreate/chat_rag_chunks.sql"), "utf8");
  assert.match(sql, /embedding_text\s+TEXT\s+NOT NULL/i);
  assert.doesNotMatch(sql, /^\s*#/m, "SQL comments must not use shell syntax");
});

test("privacy recovery schema survives preset deletion and RAG verification checks exact live source refs", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/007-privacy-operation-recovery.sql"), "utf8");
  const ragRepository = fs.readFileSync(path.join(__dirname, "../../../modules/chat/rag/repo.js"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS chat_memory_privacy_operations/i);
  assert.doesNotMatch(migration, /REFERENCES\s+chat_prompt_presets/i);
  assert.match(ragRepository, /jsonb_array_elements/);
  assert.match(ragRepository, /m\.id::TEXT=ref->>'messageId'/);
  assert.match(ragRepository, /ref->>'contentHash'='sha256:'/);
});

test("chat turn migration persists identity, idempotency, generation fences, and durable operation payloads", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/008-chat-turns-and-async-privacy.sql"), "utf8");
  for (const column of ["turn_id", "parent_user_message_id", "idempotency_key", "source_generation"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
  }
  assert.match(migration, /idx_chat_messages_scope_idempotency/i);
  assert.match(migration, /idx_chat_messages_one_assistant_per_parent/i);
  assert.match(migration, /operation_payload JSONB/i);
  assert.match(migration, /idx_memory_privacy_operations_active_scope/i);
});

test("launch-gate migration repairs duplicate diagnostics before the unique index and retires recall checkpoints", () => {
  const baseMigration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/001-memory-v2.sql"), "utf8");
  const dedupePosition = baseMigration.indexOf("WITH ranked AS");
  const uniqueIndexPosition = baseMigration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_context_diagnostics_one_active");
  assert.equal(dedupePosition >= 0 && dedupePosition < uniqueIndexPosition, true);
  assert.match(baseMigration, /ROW_NUMBER\(\) OVER[\s\S]*WHERE resolved=FALSE[\s\S]*SET resolved=TRUE/i);

  const launchGateMigration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/009-launch-gate-legacy-projections.sql"), "utf8");
  assert.match(launchGateMigration, /DELETE FROM chat_context_projection_checkpoints\s+WHERE projection_key<>'rag'/i);
  assert.match(launchGateMigration, /DELETE FROM chat_context_quality_diagnostics\s+WHERE subject_kind='projection' AND subject_key<>'rag'/i);
  assert.match(launchGateMigration, /DELETE FROM chat_memory_recovery_notifications\s+WHERE subject_kind='projection' AND subject_key<>'rag'/i);
  assert.match(launchGateMigration, /ADD CONSTRAINT chk_context_projection_key CHECK \(projection_key='rag'\)/i);
});

test("2.01 contract migration stores string schema versions on snapshots, event groups, and durable tasks", () => {
  const base = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/001-memory-v2.sql"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/010-memory-control-v201-contract.sql"), "utf8");
  assert.match(base, /chat_memory_snapshots[\s\S]*schema_version TEXT NOT NULL/i);
  assert.match(base, /chat_memory_event_groups[\s\S]*schema_version TEXT NOT NULL/i);
  assert.match(base, /chat_memory_tasks[\s\S]*schema_version TEXT NOT NULL/i);
  assert.match(migration, /chat_memory_snapshots[\s\S]*TYPE TEXT USING schema_version::TEXT/i);
  assert.match(migration, /chat_memory_event_groups[\s\S]*TYPE TEXT USING schema_version::TEXT/i);
  assert.match(migration, /chat_memory_tasks[\s\S]*ADD COLUMN IF NOT EXISTS schema_version TEXT/i);
  assert.match(migration, /task_payload #>> '\{task,schemaVersion\}'/i);
  assert.match(migration, /ALTER COLUMN schema_version SET NOT NULL/i);
});

test("2.01 cleanup migration removes evidence classification and suppression storage", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../../migrations/memory/011-memory-control-v201-cleanup.sql"), "utf8");
  assert.match(migration, /chat_memory_events DROP COLUMN IF EXISTS evidence_kind/i);
  assert.match(migration, /chat_context_projection_checkpoints DROP COLUMN IF EXISTS processed_tombstone_id/i);
  assert.match(migration, /DROP TABLE IF EXISTS chat_context_suppression_tombstones/i);
});
