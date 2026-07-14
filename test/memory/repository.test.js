const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../../db");
const { initializeRevisionZero } = require("../../modules/memory/infrastructure/repositories/stateRepository");
const { upsertTargetStatus } = require("../../modules/memory/infrastructure/repositories/runtimeRepository");
const { upsertActiveDiagnostic, resolveGapDiagnosticIfProven, resolveProjectionDiagnosticIfCovered } = require("../../modules/memory/infrastructure/repositories/sidecarRepository");
const migrationRepository = require("../../modules/memory/infrastructure/repositories/migrationRepository");
const privacyRepository = require("../../modules/memory/infrastructure/repositories/privacyRepository");
const { REQUIRED_TABLES, REQUIRED_COLUMNS, REQUIRED_INDEXES, evaluateInspection } = require("../../scripts/check-memory-schema");

test("revision zero initialization atomically creates snapshot and six target statuses", async () => {
  const originalGetClient = db.getClient;
  let state = null;
  let snapshot = null;
  const statuses = new Set();
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT memory_state")) return { rows: [{ memory_state: state }] };
      if (sql.includes("UPDATE chat_preset_memory SET memory_state")) { state = params[2]; return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO chat_memory_snapshots")) { snapshot ||= params[3]; return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO chat_memory_target_status")) { statuses.add(params[2]); return { rows: [], rowCount: 1 }; }
      if (sql.includes("SELECT state FROM chat_memory_snapshots")) return { rows: [{ state: snapshot }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  db.getClient = async () => client;
  try {
    const result = await initializeRevisionZero(1, "default");
    assert.equal(result.meta.revision, 0);
    assert.deepEqual(snapshot, result);
    assert.equal(statuses.size, 6);
    assert.ok(statements.includes("BEGIN"));
    assert.ok(statements.includes("COMMIT"));
  } finally { db.getClient = originalGetClient; }
});

test("schema inspection cannot report clean when any v2 table, column, or index is missing", () => {
  const base = {
    tables: REQUIRED_TABLES,
    columns: Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) => columns.map((column) => ({
      table_name: table, column_name: column, data_type: table === "chat_preset_memory" && column === "memory_state" ? "jsonb" : "text",
      is_nullable: "YES", column_default: null,
    }))),
    indexes: REQUIRED_INDEXES,
    userTimeZoneColumn: { data_type: "text", is_nullable: "NO" },
    legacy: { checkpointTable: false, columns: [] },
  };
  for (const column of base.columns) {
    if (column.table_name === "chat_context_quality_diagnostics" && column.column_name === "detail") {
      column.data_type = "jsonb"; column.is_nullable = "NO"; column.column_default = "'{}'::jsonb";
    }
    if (column.table_name === "chat_memory_recovery_notifications" && column.column_name === "boundary_message_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_memory_diagnostic_projection_checkpoints" && column.column_name === "processed_event_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_context_projection_checkpoints" && column.column_name === "processed_tombstone_id") {
      column.is_nullable = "NO"; column.column_default = "0";
    }
    if (column.table_name === "chat_context_quality_diagnostics" && ["truncated", "resolved"].includes(column.column_name)) column.is_nullable = "NO";
  }
  assert.equal(evaluateInspection(base).clean, true);
  assert.equal(evaluateInspection({ ...base, tables: base.tables.filter((table) => table !== "chat_memory_tasks") }).clean, false);
  assert.equal(evaluateInspection({ ...base, indexes: base.indexes.filter((index) => index !== "idx_memory_tasks_recovery") }).clean, false);
  assert.equal(evaluateInspection({ ...base, columns: base.columns.filter((column) => !(column.table_name === "chat_memory_events" && column.column_name === "normalized_operation")) }).clean, false);
});

test("partial privacy purge deletes only tombstones whose raw message no longer exists", async () => {
  const statements = [];
  const client = { async query(sql) { statements.push(sql); return { rows: [], rowCount: 0 }; } };
  await privacyRepository.purgeDerivedHistory(1, "default", { client, preserveTombstones: true });
  const tombstoneDelete = statements.find((sql) => sql.startsWith("DELETE FROM chat_context_suppression_tombstones"));
  assert.match(tombstoneDelete, /NOT EXISTS \(SELECT 1 FROM chat_messages/);
  assert.match(tombstoneDelete, /m\.id=t\.message_id/);
  assert.match(tombstoneDelete, /t\.content_hash='sha256:'/);
});

test("target recovery status and notification commit in one transaction", async () => {
  const originalGetClient = db.getClient;
  const statements = [];
  let targetStatusParams = null;
  const client = {
    async query(sql, params) {
      statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT status,rebuild_boundary_message_id FROM chat_memory_target_status")) return { rows: [{ status: "halted", rebuild_boundary_message_id: 42 }] };
      if (sql.startsWith("INSERT INTO chat_memory_target_status")) { targetStatusParams = params; return { rows: [{ target_key: "todos", status: "healthy" }], rowCount: 1 }; }
      if (sql.startsWith("SELECT status FROM chat_memory_tasks")) return { rows: [{ status: "succeeded" }] };
      if (sql.startsWith("SELECT memory_state FROM chat_preset_memory")) return { rows: [{ memory_state: { meta: { targetCursors: { todos: 42 } } } }] };
      if (sql.startsWith("INSERT INTO chat_memory_recovery_notifications")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  db.getClient = async () => client;
  try {
    await upsertTargetStatus(1, "default", { targetKey: "todos", sourceGeneration: 0, status: "healthy", consecutiveErrors: 0, lastTaskId: "00000000-0000-0000-0000-000000000001" });
    assert.ok(statements.includes("BEGIN"));
    assert.ok(statements.includes("COMMIT"));
    assert.equal(targetStatusParams[4], 42);
    assert.equal(statements.some((sql) => sql.startsWith("INSERT INTO chat_memory_recovery_notifications") && sql.includes("boundary_message_id")), true);
  } finally { db.getClient = originalGetClient; }
});

test("active context diagnostics reject stale boundary regressions and resolve only proven rows", async () => {
  const statements = [];
  const existing = {
    id: 9,
    source_generation: 2,
    diagnostic_type: "gap_bridge_omitted",
    omitted_upper_message_id: 100,
    resolved: false,
  };
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith("INSERT INTO chat_context_quality_diagnostics")) return { rows: [] };
      if (sql.startsWith("SELECT * FROM chat_context_quality_diagnostics")) return { rows: [existing] };
      if (sql.includes("diagnostic_type='gap_bridge_omitted'")) return { rows: [existing] };
      if (sql.includes("diagnostic_type='projection_lag'")) return { rows: [{ ...existing, diagnostic_type: "projection_lag", recent_window_start: 101 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const row = await upsertActiveDiagnostic(1, "default", {
    subjectKind: "target",
    subjectKey: "todos",
    diagnosticType: "gap_bridge_omitted",
    sourceGeneration: 2,
    omittedUpperMessageId: 40,
    truncated: true,
  }, { client });
  assert.equal(row.omitted_upper_message_id, 100);
  assert.match(statements[0], /EXCLUDED\.omitted_upper_message_id.*chat_context_quality_diagnostics\.omitted_upper_message_id/);
  await resolveGapDiagnosticIfProven(9, { sourceGeneration: 2, provenUpperMessageId: 100 }, { client });
  await resolveProjectionDiagnosticIfCovered(10, { sourceGeneration: 2, processedBoundaryMessageId: 100 }, { client });
  assert.equal(statements.some((sql) => /omitted_upper_message_id<=\$3/.test(sql)), true);
  assert.equal(statements.some((sql) => /recent_window_start,1\)-1\)<=\$3/.test(sql)), true);
});

test("stage 8 source inventory reads raw messages without mutating them", async () => {
  const statements = [];
  const client = { async query(sql) { statements.push(sql.replace(/\s+/g, " ").trim()); return { rows: [] }; } };
  await migrationRepository.listSourceScopes({ client });
  assert.equal(statements.some((sql) => sql.includes("FROM chat_messages")), true);
  assert.equal(statements.some((sql) => /(?:DELETE FROM|UPDATE) chat_messages\b/i.test(sql)), false);
});

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
