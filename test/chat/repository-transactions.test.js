const test = require("node:test");
const assert = require("node:assert/strict");

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let nextClient = null;
const db = {
  async getClient() {
    if (!nextClient) throw new Error("Unexpected getClient call");
    return nextClient;
  },
  async query() { throw new Error("Unexpected pool query"); },
};
replaceModule("../../db", db);
const { createChatRepository } = require("../../modules/chat/infrastructure/repositories/chatRepository");
const chatModel = createChatRepository({ database: db });

function createClient(dispatch) {
  const statements = [];
  let released = false;
  return {
    statements,
    get released() { return released; },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      statements.push(normalized);
      return dispatch(normalized, params);
    },
    release() { released = true; },
  };
}

function successfulDeleteClient() {
  return createClient(async (sql) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT id, preset_id")) return { rows: [{ id: 17, preset_id: "companion" }], rowCount: 1 };
    if (sql.startsWith("SELECT MIN(id) AS min_id")) return { rows: [{ min_id: "42" }], rowCount: 1 };
    if (sql.startsWith("DELETE FROM chat_sessions")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

test("permanent session deletion owns a transaction unless a caller supplies one", async (t) => {
  await t.test("an internally owned transaction commits and releases after all reads and the delete", async () => {
    const client = successfulDeleteClient();
    nextClient = client;
    const result = await chatModel.deleteSessionPermanently(9, 17);
    assert.deepEqual(result, { id: 17, preset_id: "companion", firstMessageId: 42 });
    assert.deepEqual(client.statements.map((sql) => sql.split(" ")[0]), ["BEGIN", "SELECT", "SELECT", "DELETE", "COMMIT"]);
    assert.equal(client.released, true);
  });

  await t.test("a missing trashed session rolls back and returns null", async () => {
    const client = createClient(async (sql) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT id, preset_id")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    nextClient = client;
    assert.equal(await chatModel.deleteSessionPermanently(9, 999), null);
    assert.deepEqual(client.statements.map((sql) => sql.split(" ")[0]), ["BEGIN", "SELECT", "ROLLBACK"]);
    assert.equal(client.released, true);
  });

  await t.test("an internally owned transaction rolls back and releases on failure", async () => {
    const failure = new Error("range read failed");
    const client = createClient(async (sql) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT id, preset_id")) return { rows: [{ id: 17, preset_id: "companion" }], rowCount: 1 };
      if (sql.startsWith("SELECT MIN(id) AS min_id")) throw failure;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    nextClient = client;
    await assert.rejects(chatModel.deleteSessionPermanently(9, 17), failure);
    assert.equal(client.statements.at(-1), "ROLLBACK");
    assert.equal(client.released, true);
  });

  await t.test("a supplied transaction context is neither committed, rolled back, nor released", async () => {
    const client = successfulDeleteClient();
    nextClient = null;
    const result = await chatModel.deleteSessionPermanently(9, 17, { client });
    assert.deepEqual(result, { id: 17, preset_id: "companion", firstMessageId: 42 });
    assert.deepEqual(client.statements.map((sql) => sql.split(" ")[0]), ["SELECT", "SELECT", "DELETE"]);
    assert.equal(client.released, false);
  });
});
