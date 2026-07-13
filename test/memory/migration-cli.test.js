const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, resolveOptions } = require("../../scripts/migrate-memory-v2-data");

test("Memory v2 data migration CLI defaults to read-only inventory", () => {
  assert.deepEqual(resolveOptions(parseArgs([])), {
    mode: "inventory",
    scopes: undefined,
    apply: false,
    serviceStopped: false,
    reportPath: null,
  });
});

test("Memory v2 data migration CLI requires explicit scope pairs and cutover confirmation", () => {
  assert.throws(() => resolveOptions(parseArgs(["--user", "1"])), /provided together/);
  assert.deepEqual(resolveOptions(parseArgs([
    "--mode", "cutover", "--user", "1", "--preset", "lina", "--apply", "--service-stopped", "--report", "reports/cutover.json",
  ])), {
    mode: "cutover",
    scopes: [{ userId: 1, presetId: "lina" }],
    apply: true,
    serviceStopped: true,
    reportPath: require("node:path").resolve("reports/cutover.json"),
  });
});
