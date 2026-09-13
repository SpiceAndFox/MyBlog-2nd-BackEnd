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

test("an unchanged pending idempotent turn can resume in a recovered generation", async () => {
  const existing = { id: 42, session_id: 17, turn_id: "original-turn", content: "hello", source_generation: 2 };
  const client = createClient(async (sql, params) => {
    if (sql.startsWith("INSERT INTO chat_messages")) return { rows: [] };
    if (sql.startsWith("SELECT id,session_id")) return { rows: [existing] };
    if (sql.startsWith("UPDATE chat_messages u SET source_generation")) {
      assert.deepEqual(params, [42, 9, 17, 3, "hello", "original-turn", "same-key"]);
      assert.match(sql, /NOT EXISTS.*parent_user_message_id/u);
      assert.match(sql, /s.deleted_at IS NULL/u);
      return { rows: [{ ...existing, source_generation: 3 }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await chatModel.createUserMessage(9, 17, "hello", {
    turnId: "unused-new-turn", idempotencyKey: "same-key", sourceGeneration: 3, client,
  });
  assert.equal(result.created, false);
  assert.equal(result.message.id, 42);
  assert.equal(result.message.turn_id, "original-turn");
  assert.equal(result.message.source_generation, 3);
});

test("generation refresh never rewrites an already completed turn or mismatched content", async () => {
  let content = "hello";
  let updates = 0;
  const client = createClient(async sql => {
    if (sql.startsWith("INSERT INTO chat_messages")) return { rows: [] };
    if (sql.startsWith("SELECT id,session_id")) return { rows: [{ id: 42, session_id: 17, turn_id: "original", content, source_generation: 2 }] };
    if (sql.startsWith("UPDATE chat_messages u SET source_generation")) { updates++; return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const options = { turnId: "unused", idempotencyKey: "key", sourceGeneration: 3, client };
  assert.equal((await chatModel.createUserMessage(9, 17, "hello", options)).message.source_generation, 2);
  content = "edited";
  await assert.rejects(chatModel.createUserMessage(9, 17, "hello", options), { code: "CHAT_IDEMPOTENCY_CONFLICT" });
  assert.equal(updates, 1);
});
