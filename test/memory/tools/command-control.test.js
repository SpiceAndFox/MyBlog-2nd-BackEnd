const test = require("node:test");
const assert = require("node:assert/strict");

test("all foreground CLIs reject the removed wait-timeout option", () => {
  for (const file of ["rebuild-memory-v2-scope", "migrate-memory-v2-data", "run-memory-v2-librarian"]) {
    const { parseArgs } = require(`../../../scripts/${file}`);
    assert.throws(() => parseArgs(["--wait-timeout-ms", "3000"]), /Unknown argument/);
  }
});

function captureLogs(events) {
  const { logWait } = require("../../../scripts/memory-command-control");
  let text = "";
  const previous = process.stderr.write;
  process.stderr.write = value => { text += value; return true; };
  try {
    events.forEach(logWait);
  } finally { process.stderr.write = previous; }
  return text;
}

test("wait logs show the current blocker once without expanding wave history", () => {
  const blocker = { status: "error", halted: false, taskId: "d7deb729-ae28-4578-8bc6-6710bb270f91",
    reason: "llm_call_failed", detail: { code: "MEMORY_PROVIDER_TIMEOUT" }, rejectedOutput: "private" };
  const text = captureLogs([{ event: "memory_waiting", scope: { userId: 1, presetId: "Lina-Weil" }, phase: "memory",
    notBefore: "2026-09-11T15:14:03.788Z", waitCount: 1, totalWaitCount: 10,
    result: { status: "incomplete", targetKey: "profileRelationship", result: blocker,
      results: [{ status: "committed", taskId: "completed-task" }, { status: "prepared" }, blocker] } }]);
  assert.match(text, /\[等待 1\] 1\/Lina-Weil · 记忆 · profileRelationship · 任务 d7deb729 · 请求超时 · 下次 /);
  assert.equal(text.match(/d7deb729/g).length, 1);
  assert.ok(text.includes(new Date("2026-09-11T15:14:03.788Z").toLocaleString("zh-CN", { hour12: false })));
  assert.equal(text.trim().split("\n").length, 1);
  assert.doesNotMatch(text, /private|completed-task|committed|prepared|totalWaitCount|ae28/);
});

test("dispatch and durable progress use distinct brief messages", () => {
  const common = { scope: { userId: 1, presetId: "default" }, phase: "memory", waitCount: 2,
    result: { status: "retry_wait", taskId: "task", reason: "provider_queue_full", mode: "maintenance" } };
  const text = captureLogs([
    { ...common, event: "memory_waiting", notBefore: "2026-09-11T00:00:00Z" },
    { ...common, event: "memory_wait_finished" },
    { ...common, event: "memory_progress_resumed" },
  ]);
  const lines = text.trim().split("\n");
  assert.match(lines[0], /容量维护 · 任务 task · 请求队列已满/);
  assert.equal(lines[1], "[继续调度] 1/default · 记忆 · 容量维护 · 任务 task");
  assert.equal(lines[2], "[进度已推进] 1/default · 记忆");
});

test("nested projection barriers retain an actionable HTTP failure", () => {
  const text = captureLogs([{ event: "memory_waiting", scope: { userId: 1, presetId: "default" }, phase: "rag", waitCount: 1,
    result: { status: "incomplete", barrier: { status: "incomplete", results: [
      { status: "retry_wait", reason: "projection_provider_unavailable", detail: { status: 429 } },
    ] } } }]);
  assert.match(text, /检索索引 · 服务请求失败（HTTP 429）/);
});
