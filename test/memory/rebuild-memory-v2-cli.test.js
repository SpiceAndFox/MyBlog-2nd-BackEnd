const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveOptions,
  rebuildScope,
} = require("../../scripts/rebuild-memory-v2-scope");

test("scoped Memory v2 rebuild CLI requires exactly one user and preset scope", () => {
  assert.deepEqual(resolveOptions(parseArgs(["--userId", "1", "--presetId", "Alice"])), {
    help: false,
    userId: 1,
    presetId: "Alice",
  });
  assert.throws(() => resolveOptions(parseArgs(["--userId", "1"])), /presetId cannot be empty/);
  assert.throws(() => resolveOptions(parseArgs(["--userId", "0", "--presetId", "Alice"])), /positive integer/);
  assert.throws(() => parseArgs(["--user", "1", "--presetId", "Alice"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--userId", "1", "--userId", "2", "--presetId", "Alice"]), /Duplicate argument/);
});

test("scoped rebuild verifies the active preset and rebuilds only its inventory row", async () => {
  const calls = [];
  const history = { userId: 1, presetId: "Alice", messageCount: 42, boundaryMessageId: 1155 };
  const db = {
    async query(sql, params) {
      calls.push({ kind: "query", sql, params });
      return { rows: [{ exists: 1 }] };
    },
  };
  const migration = {
    async inventory(scopes) {
      calls.push({ kind: "inventory", scopes });
      return [history];
    },
    async rebuildScope(scope, selectedHistory, options) {
      calls.push({ kind: "rebuild", scope, history: selectedHistory, options });
      return { ...scope, sourceGeneration: 2, boundaryMessageId: 1155, healthyTargetCount: 6 };
    },
  };

  const result = await rebuildScope({ db, migration, userId: 1, presetId: "Alice" });

  assert.deepEqual(result, {
    status: "completed",
    userId: 1,
    presetId: "Alice",
    sourceGeneration: 2,
    boundaryMessageId: 1155,
    healthyTargetCount: 6,
  });
  assert.deepEqual(calls[0].params, [1, "Alice"]);
  assert.deepEqual(calls[1], { kind: "inventory", scopes: [{ userId: 1, presetId: "Alice" }] });
  assert.deepEqual(calls[2], {
    kind: "rebuild",
    scope: { userId: 1, presetId: "Alice" },
    history,
    options: { forceNewGeneration: true },
  });
});

test("scoped rebuild refuses a missing or deleted preset before inventory", async () => {
  let inventoryCalled = false;
  await assert.rejects(() => rebuildScope({
    db: { async query() { return { rows: [] }; } },
    migration: { async inventory() { inventoryCalled = true; return []; } },
    userId: 1,
    presetId: "missing",
  }), /Active preset not found/);
  assert.equal(inventoryCalled, false);
});
