const test = require("node:test");
const assert = require("node:assert/strict");

test("all foreground CLIs reject the removed wait-timeout option", () => {
  for (const file of ["rebuild-memory-v2-scope", "migrate-memory-v2-data", "run-memory-v2-librarian"]) {
    const { parseArgs } = require(`../../../scripts/${file}`);
    assert.throws(() => parseArgs(["--wait-timeout-ms", "3000"]), /Unknown argument/);
  }
});

test("wait logs include scope, phase, task, reason and deadline without output contents", () => {
  const { logWait } = require("../../../scripts/memory-command-control");
  let text = "";
  const previous = process.stderr.write;
  process.stderr.write = value => { text += value; return true; };
  try {
    logWait({ event: "memory_wait_finished", scope: { userId: 1, presetId: "default" }, phase: "memory",
      notBefore: "2026-09-11T00:00:00Z", waitCount: 2, totalWaitCount: 3,
      result: { status: "retry_wait", taskId: "task", reason: "llm_call_failed", mode: "maintenance", rejectedOutput: "private" } });
  } finally { process.stderr.write = previous; }
  const event = JSON.parse(text);
  assert.equal(event.event, "memory_wait_finished");
  assert.equal(event.scope.presetId, "default");
  assert.equal(event.phase, "memory");
  assert.equal(event.operation.taskId, "task");
  assert.equal(event.operation.mode, "maintenance");
  assert.equal(event.operation.reason, "llm_call_failed");
  assert.ok(event.notBefore);
  assert.doesNotMatch(text, /private/);
});
