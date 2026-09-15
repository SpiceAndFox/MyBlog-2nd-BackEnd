const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { createChatGistRepository } = require("../../modules/chat/infrastructure/repositories/gistRepository");

// Explicit test connection only. Never fall back to application DATABASE_URL.
const connectionString = process.env.GIST_TEST_DATABASE_URL;
test("gist migration and durable repository against isolated PostgreSQL", { skip: !connectionString }, async t => {
  const schema = `gist_test_${Date.now()}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
  const db = { query: (sql, args) => pool.query(sql, args), getClient: () => pool.connect() };
  const repo = createChatGistRepository({ database: db });
  const scope = { userId: 1, presetId: "p", messageId: 2 };
  const result = { gistText: "summary", providerId: "test", modelId: "test" };
  async function reset() {
    await pool.query("TRUNCATE chat_gist_tasks,chat_message_gists,chat_messages,chat_sessions,chat_prompt_presets CASCADE");
    await pool.query(`INSERT INTO chat_prompt_presets VALUES(1,'p',NULL);
      INSERT INTO chat_sessions VALUES(1,1,NULL);
      INSERT INTO chat_messages VALUES(1,1,1,'p','user','question',NULL),(2,1,1,'p','assistant','long answer',1)`);
  }
  try {
    await pool.query(`CREATE TABLE chat_prompt_presets(user_id BIGINT,preset_id TEXT,deleted_at TIMESTAMPTZ,PRIMARY KEY(user_id,preset_id));
      CREATE TABLE chat_sessions(id BIGINT PRIMARY KEY,user_id BIGINT,deleted_at TIMESTAMPTZ);
      CREATE TABLE chat_messages(id BIGINT PRIMARY KEY,session_id BIGINT REFERENCES chat_sessions(id),user_id BIGINT,preset_id TEXT,role TEXT,content TEXT,parent_user_message_id BIGINT);`);
    await pool.query(fs.readFileSync(path.join(__dirname, "../../models/tableCreate/alter_chat_message_gists_add_table.sql"), "utf8"));
    const migration = fs.readFileSync(path.join(__dirname, "../../migrations/chat/001-gist-tasks.sql"), "utf8");
    await pool.query(migration); await pool.query(migration);

    await t.test("concurrent enqueue deduplicates and only one worker claims; success is atomic", async () => {
      await reset(); await Promise.all([repo.enqueueGistTask(scope), repo.enqueueGistTask(scope)]);
      assert.equal((await pool.query("SELECT COUNT(*) FROM chat_gist_tasks")).rows[0].count, "1");
      const claimed = await Promise.all([repo.claimGistTask({ leaseMs: 60000 }), repo.claimGistTask({ leaseMs: 60000 })]);
      assert.equal(claimed.filter(Boolean).length, 1);
      await repo.finishGistTask(claimed.find(Boolean), { result });
      const cached = await repo.listGistsByMessageIds(1, "p", [2]);
      assert.equal(cached[0].gistText, "summary");
      assert.equal((await repo.enqueueGistTask(scope)).status, "succeeded");
      assert.equal(await repo.claimGistTask({ leaseMs: 60000 }), null);
    });

    await t.test("an expired owner cannot overwrite a replacement claim", async () => {
      await reset(); await repo.enqueueGistTask(scope);
      const old = await repo.claimGistTask({ leaseMs: 60000 });
      await pool.query("UPDATE chat_gist_tasks SET lease_until=NOW()-INTERVAL '1 second'");
      const current = await repo.claimGistTask({ leaseMs: 60000 });
      assert.equal(current.attempt, 2);
      assert.equal((await repo.finishGistTask(old, { result })).status, "stale");
      await repo.finishGistTask(current, { result: { ...result, gistText: "new" } });
      assert.equal((await repo.getGist(1, "p", 2)).gistText, "new");
    });

    await t.test("editing assistant or its user input rejects stale results and invalidates cache", async () => {
      for (const id of [1, 2]) {
        await reset(); await repo.enqueueGistTask(scope);
        const task = await repo.claimGistTask({ leaseMs: 60000 });
        await pool.query("UPDATE chat_messages SET content='edited' WHERE id=$1", [id]);
        assert.equal((await repo.finishGistTask(task, { result })).status, "cancelled");
        assert.equal(await repo.getGist(1, "p", 2), null);
        await repo.enqueueGistTask(scope); const replacement = await repo.claimGistTask({ leaseMs: 60000 });
        assert.equal(replacement.attempt, 1); await repo.finishGistTask(replacement, { result });
        await pool.query("UPDATE chat_messages SET content='edited again' WHERE id=$1", [id]);
        assert.deepEqual(await repo.listGistsByMessageIds(1, "p", [2]), []);
      }
    });

    await t.test("soft deletion and privacy purge prevent late writes; hard delete cascades tasks", async () => {
      for (const mutation of ["UPDATE chat_sessions SET deleted_at=NOW()", "UPDATE chat_prompt_presets SET deleted_at=NOW()", "DELETE FROM chat_gist_tasks", "DELETE FROM chat_messages WHERE id=2"]) {
        await reset(); await repo.enqueueGistTask(scope); const task = await repo.claimGistTask({ leaseMs: 60000 });
        await pool.query(mutation); await repo.finishGistTask(task, { result });
        assert.equal(await repo.getGist(1, "p", 2), null);
      }
      assert.equal(await repo.countGistTasksByScope(1, "p"), 0);
    });

    await t.test("failed tasks require explicit retry, backfill does not reset the allowance", async () => {
      await reset(); await repo.enqueueGistTask(scope); const task = await repo.claimGistTask({ leaseMs: 60000 });
      await repo.finishGistTask(task, { status: "failed", reason: "http_401" });
      assert.equal((await repo.enqueueGistTask(scope)).status, "failed");
      assert.equal(await repo.claimGistTask({ leaseMs: 60000 }), null);
      assert.equal((await repo.enqueueGistTask(scope, { force: true })).attempt, 0);
      assert.equal((await repo.claimGistTask({ leaseMs: 60000 })).attempt, 1);
    });

    await t.test("source row locks serialize edits with successful gist writes", async () => {
      await reset(); await repo.enqueueGistTask(scope); const task = await repo.claimGistTask({ leaseMs: 60000 });
      const editor = await pool.connect();
      try {
        await editor.query("BEGIN"); await editor.query("UPDATE chat_messages SET content='concurrent edit' WHERE id=1");
        const finish = repo.finishGistTask(task, { result });
        await editor.query("COMMIT");
        assert.equal((await finish).status, "cancelled");
        assert.equal(await repo.getGist(1, "p", 2), null);
      } finally { await editor.query("ROLLBACK"); editor.release(); }
    });
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
