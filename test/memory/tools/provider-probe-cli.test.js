const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, main } = require("../../../scripts/probe-memory-v2-provider");

test("provider probe CLI selects the default probes or Todo-only probes explicitly", () => {
  assert.deepEqual(parseArgs([]), { todoOnly: false });
  assert.deepEqual(parseArgs(["--todo-only"]), { todoOnly: true });
});

test("provider probe CLI rejects unknown arguments before loading configuration or dispatching probes", async () => {
  for (const args of [["--todo-onyl"], ["--todo-only", "unexpected"], ["--todo-only=true"]]) {
    assert.throws(() => parseArgs(args), /Usage:/);
    await assert.rejects(main(args), /Usage:/);
  }
});
