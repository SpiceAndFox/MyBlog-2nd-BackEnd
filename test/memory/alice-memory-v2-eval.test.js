const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateAliceTaskReplay } = require("../../evals/memory-v2/aliceAssertions");
const { parseArgs } = require("../../scripts/evaluate-alice-memory-v2-report");

test("Alice evaluation CLI accepts only a persisted generic replay report", () => {
  assert.equal(parseArgs(["--report", "reports/shadow.json"]).report.endsWith("shadow.json"), true);
  assert.throws(() => parseArgs(["--taskId", "task"]), /Usage:/);
});

test("Alice evaluation interprets a generic shadow replay report outside the Memory module", () => {
  const report = {
    task: {
      targetKey: "todos",
      sourceBoundary: { cursorBefore: 1077, targetMessageId: 1080 },
      observedMessageIds: [1078, 1079, 1080],
    },
    replay: {
      semanticResult: {
        sectionResults: {
          todos: {
            status: "changes",
            changes: [
              { action: "add", dueAt: { mode: "relative", days: 1 } },
              { action: "add", dueAt: { mode: "relative", days: 1 } },
            ],
          },
        },
      },
      reducerPreflight: {
        events: [
          { section: "todos", decision: "accepted", op: "addItem", rejectReason: null },
          { section: "todos", decision: "accepted", op: "addItem", rejectReason: null },
        ],
      },
    },
  };

  const evaluation = evaluateAliceTaskReplay(report);
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.applicableCount, 1);
  assert.equal(evaluation.assertions.find((entry) => entry.id === "alice_two_tomorrow_todos_1078_1080").passed, true);
});

test("Alice evaluation ignores cases that appear only in overlap context", () => {
  const evaluation = evaluateAliceTaskReplay({
    task: {
      targetKey: "todos",
      sourceBoundary: { cursorBefore: 710, targetMessageId: 718 },
      observedMessageIds: [684, 687, 696, 711, 718],
    },
    replay: { semanticResult: null, reducerPreflight: { events: [] } },
  });
  assert.equal(evaluation.applicableCount, 0);
  assert.equal(evaluation.passed, null);
});
