const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareValue } = require("pg/lib/utils");
const db = require("../../db");
const { initializeRevisionZero } = require("../../modules/memory/infrastructure/repositories/stateRepository");
const { insertEvents } = require("../../modules/memory/infrastructure/repositories/auditRepository");
const { upsertTargetStatus } = require("../../modules/memory/infrastructure/repositories/runtimeRepository");
const { upsertActiveDiagnostic, resolveGapDiagnosticIfProven, resolveProjectionDiagnosticIfCovered, listProjectionCheckpoints } = require("../../modules/memory/infrastructure/repositories/sidecarRepository");
const migrationRepository = require("../../modules/memory/infrastructure/repositories/migrationRepository");
const privacyRepository = require("../../modules/memory/infrastructure/repositories/privacyRepository");
const { getHistoryFingerprint } = require("../../modules/memory/infrastructure/repositories/sourceRepository");

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

test("merge event arrays are encoded as JSONB rather than PostgreSQL arrays", async () => {
  const mergedFromItemIds = ["userProfile:first", "userProfile:second"];
  let insertedParams;
  const client = {
    async query(_sql, params) {
      insertedParams = params;
      return { rows: [{}], rowCount: 1 };
    },
  };
  await insertEvents([{
    event_group_id: "00000000-0000-0000-0000-000000000001",
    event_index: 0,
    user_id: 1,
    preset_id: "default",
    task_id: "00000000-0000-0000-0000-000000000002",
    target_key: "profileRelationship",
    section: "userProfile",
    event_kind: "proposal_decision",
    decision: "accepted",
    op: "mergeItems",
    merged_from_item_ids: mergedFromItemIds,
    patch_summary: { op: "mergeItems", itemIds: mergedFromItemIds },
    normalized_operation: { op: "mergeItems", itemIds: mergedFromItemIds },
  }], { client });

  assert.equal(typeof insertedParams[14], "string");
  assert.deepEqual(JSON.parse(prepareValue(insertedParams[14])), mergedFromItemIds);
  assert.deepEqual(JSON.parse(prepareValue(insertedParams[18])).itemIds, mergedFromItemIds);
  assert.deepEqual(JSON.parse(prepareValue(insertedParams[19])).itemIds, mergedFromItemIds);
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

test("migration source inventory reads raw messages without mutating them", async () => {
  const statements = [];
  const client = { async query(sql) { statements.push(sql.replace(/\s+/g, " ").trim()); return { rows: [] }; } };
  await migrationRepository.listSourceScopes({ client });
  assert.equal(statements.some((sql) => sql.includes("FROM chat_messages")), true);
  assert.equal(statements.some((sql) => /(?:DELETE FROM|UPDATE) chat_messages\b/i.test(sql)), false);
});

test("migration source fingerprint detects same-length content and turn-identity changes without exposing raw text", async () => {
  async function fingerprint(overrides = {}) {
    const client = {
      async query() {
        return { rows: [{
          id: "10", session_id: "3", role: "user", content: "abcd",
          created_at: "2026-07-15T00:00:00Z", turn_id: "turn-a", parent_user_message_id: null,
          ...overrides,
        }] };
      },
    };
    return getHistoryFingerprint(1, "default", { client });
  }
  const original = await fingerprint();
  assert.match(original, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(await fingerprint({ content: "wxyz" }), original);
  assert.notEqual(await fingerprint({ turn_id: "turn-b" }), original);
  assert.doesNotMatch(original, /abcd/);
});

test("projection checkpoint reads exclude retired recall rows", async () => {
  let statement = "";
  const client = { async query(sql) { statement = sql; return { rows: [] }; } };
  await listProjectionCheckpoints(1, "default", { client });
  assert.match(statement, /projection_key='rag'/);
});
