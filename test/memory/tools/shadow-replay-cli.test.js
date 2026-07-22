const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parseArgs, resolveOptions } = require("../../../scripts/shadow-replay-memory-v2-task");

const TASK_ID = "12345678-1234-5678-9234-123456789abc";

test("task shadow replay CLI accepts one task and optional explicit comparison model", () => {
  assert.deepEqual(resolveOptions(parseArgs(["--taskId", TASK_ID])), {
    help: false,
    taskId: TASK_ID,
    model: null,
    report: null,
  });
  const options = resolveOptions(parseArgs([
    "--taskId", TASK_ID,
    "--model", "stronger-model",
    "--report", "reports/shadow.json",
  ]));
  assert.equal(options.model, "stronger-model");
  assert.equal(path.basename(options.report), "shadow.json");
});

test("task shadow replay CLI rejects missing, invalid, and duplicate arguments", () => {
  assert.throws(() => resolveOptions(parseArgs([])), /taskId must be a UUID/);
  assert.throws(() => resolveOptions(parseArgs(["--taskId", "not-a-uuid"])), /taskId must be a UUID/);
  assert.throws(() => parseArgs(["--taskId", TASK_ID, "--taskId", TASK_ID]), /Duplicate argument/);
  assert.throws(() => parseArgs(["--userId", "1"]), /Unknown argument/);
});
