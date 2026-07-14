const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the v1 schema removal migration drops only obsolete Memory storage", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../migrations/memory/002-drop-memory-v1.sql"), "utf8");
  assert.match(sql, /DROP TABLE IF EXISTS chat_preset_memory_checkpoints/i);
  for (const column of ["rolling_summary", "core_memory", "dirty_since_message_id", "rebuild_required"]) {
    assert.match(sql, new RegExp(`DROP COLUMN IF EXISTS ${column}`, "i"));
  }
  assert.doesNotMatch(sql, /(?:DELETE FROM|UPDATE|DROP TABLE(?: IF EXISTS)?)\s+chat_messages\b/i);
});

test("User time-zone migration backfills non-terminal immutable task payloads", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../migrations/memory/003-add-user-time-zone.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'UTC'/i);
  assert.match(sql, /jsonb_set\(task\.task_payload, '\{task,userTimeZone\}'/i);
  assert.match(sql, /task\.status IN \('queued', 'running', 'retry_wait'\)/i);
});

test("diagnostic projection migration adds generic detail and a durable event checkpoint", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../migrations/memory/004-add-diagnostic-projection-checkpoints.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_memory_diagnostic_projection_checkpoints/i);
  assert.match(sql, /processed_event_id BIGINT NOT NULL DEFAULT 0/i);
});

test("fresh RAG schema includes the embedding text required by the v2 projection adapter", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../models/tableCreate/chat_rag_chunks.sql"), "utf8");
  assert.match(sql, /embedding_text\s+TEXT\s+NOT NULL/i);
  assert.doesNotMatch(sql, /^\s*#/m, "SQL comments must not use shell syntax");
});

test("privacy recovery schema survives preset deletion and RAG verification checks exact live source refs", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../migrations/memory/007-privacy-operation-recovery.sql"), "utf8");
  const ragRepository = fs.readFileSync(path.join(__dirname, "../../services/chat/rag/repo.js"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS chat_memory_privacy_operations/i);
  assert.doesNotMatch(migration, /REFERENCES\s+chat_prompt_presets/i);
  assert.match(ragRepository, /jsonb_array_elements/);
  assert.match(ragRepository, /m\.id::TEXT=ref->>'messageId'/);
  assert.match(ragRepository, /ref->>'contentHash'='sha256:'/);
});

test("RAG dialogue enrichment remains bounded by the effective retrieval cutoff", () => {
  const retriever = fs.readFileSync(path.join(__dirname, "../../services/chat/rag/retriever.js"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "../../services/chat/rag/repo.js"), "utf8");
  assert.match(retriever, /maxMessageId:\s*beforeMessageId/);
  assert.match(repository, /AND id > \$4\s+AND id <= \$5\s+ORDER BY id ASC\s+LIMIT \$6/);
});

