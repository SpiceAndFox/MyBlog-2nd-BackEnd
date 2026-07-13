const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../db");
const { initializeRevisionZero } = require("../../modules/memory/infrastructure/repositories/stateRepository");
const { upsertTargetStatus } = require("../../modules/memory/infrastructure/repositories/runtimeRepository");
const migrationRepository = require("../../modules/memory/infrastructure/repositories/migrationRepository");

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

test("target recovery status and notification commit in one transaction", async () => {
  const originalGetClient = db.getClient;
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT status FROM chat_memory_target_status")) return { rows: [{ status: "halted" }] };
      if (sql.startsWith("INSERT INTO chat_memory_target_status")) return { rows: [{ target_key: "todos", status: "healthy" }], rowCount: 1 };
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
    assert.equal(statements.some((sql) => sql.startsWith("INSERT INTO chat_memory_recovery_notifications") && sql.includes("boundary_message_id")), true);
  } finally { db.getClient = originalGetClient; }
});

test("stage 8 legacy purge physically clears v1 values and checkpoints and verifies no residue", async () => {
  const statements = [];
  let countQuery = 0;
  const client = {
    async query(sql) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("DELETE FROM chat_preset_memory_checkpoints")) return { rows: [], rowCount: 3 };
      if (sql.includes("UPDATE chat_preset_memory")) return { rows: [], rowCount: 2 };
      if (sql.includes("SELECT COUNT(*)::BIGINT AS count")) {
        countQuery += 1;
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const purged = await migrationRepository.purgeLegacyMemory({ client });
  const residue = await migrationRepository.getLegacyResidue({ client });
  assert.deepEqual(purged, { memoryRows: 2, checkpointRows: 3 });
  assert.deepEqual(residue, { memoryRows: 0, checkpointRows: 0 });
  assert.equal(countQuery, 2);
  assert.equal(statements.some((sql) => sql.includes("rolling_summary=''")), true);
  assert.equal(statements.some((sql) => sql.startsWith("DELETE FROM chat_preset_memory_checkpoints")), true);
});
