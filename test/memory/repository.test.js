const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../db");
const { initializeRevisionZero } = require("../../modules/memory/infrastructure/repositories/stateRepository");

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
