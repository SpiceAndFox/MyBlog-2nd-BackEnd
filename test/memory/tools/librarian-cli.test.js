const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveOptions,
  runLibrarian,
} = require("../../../scripts/run-memory-v2-librarian");

test("Memory Librarian CLI requires exactly one user and preset scope", () => {
  assert.equal(resolveOptions(parseArgs(["--userId", "7", "--presetId", "companion", "--resume-failed"])).resumeFailed, true);
  assert.deepEqual(resolveOptions(parseArgs(["--userId", "7", "--presetId", "companion"])), {
    help: false,
    userId: 7,
    presetId: "companion",
  });
  assert.throws(() => resolveOptions(parseArgs(["--userId", "0", "--presetId", "companion"])), /positive integer/);
  assert.throws(() => parseArgs(["--all", "true"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--userId", "1", "--userId", "2"]), /Duplicate argument/);
});

test("Memory Librarian CLI validates the preset before invoking the maintenance pipeline", async () => {
  const calls = [];
  const result = await runLibrarian({
    db: { async query() { return { rows: [{ "?column?": 1 }] }; } },
    librarian: { async runManualAndWait(userId, presetId) { calls.push([userId, presetId]); return { status: "completed" }; } },
    userId: 7,
    presetId: "companion",
  });
  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(calls, [[7, "companion"]]);
  await assert.rejects(() => runLibrarian({
    db: { async query() { return { rows: [] }; } },
    librarian: { async runManualAndWait() { throw new Error("must not run"); } },
    userId: 7,
    presetId: "missing",
  }), /Active preset not found/);
});
