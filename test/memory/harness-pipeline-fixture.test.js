const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadFixtureCatalog, loadFixtures, runCompiledFixture } = require("../../modules/memory/harness/runner");
const { createMemoryTestConfig } = require("./support/memory-builders");

test("2.01 Harness catalog has no legacy proposal fixtures and executes compiled fixtures", () => {
  const root = path.join(__dirname, "../../modules/memory/harness/fixtures");
  const catalog = loadFixtureCatalog(root);
  assert.deepEqual(catalog.map((entry) => entry.fixtureKind).sort(), ["compiledReducer", "compiledReducer", "context"]);
  const recoveryCatalog = loadFixtureCatalog(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures"));
  assert.equal(recoveryCatalog.length, 4);
  assert.equal(recoveryCatalog.every((entry) => entry.fixtureKind === "recovery"), true);
  const idFactory = (() => { let id = 0; return () => `fixture-${++id}`; })();
  for (const { fixture, filePath } of loadFixtures(root)) {
    const result = runCompiledFixture(fixture, { config: createMemoryTestConfig(), idFactory }, { filePath });
    assert.equal(result.results.every((entry) => entry.outcome === "committable"), true);
  }
});
