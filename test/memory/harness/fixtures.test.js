const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FIXTURE_KINDS,
  loadCompiledFixtures,
  loadFixtureCatalog,
  loadFixturesByKind,
  runCompiledFixture,
  validateFixture,
} = require("../../../modules/memory/harness/runner");
const { createMemoryTestConfig } = require("../support/memory-builders");

test("Harness validates every catalog entry and executes every compiled reducer fixture", () => {
  const root = path.join(__dirname, "../../../modules/memory/harness/fixtures");
  const recoveryRoot = path.join(__dirname, "../../../modules/memory/harness/recovery-fixtures");
  const catalog = [...loadFixtureCatalog(root), ...loadFixtureCatalog(recoveryRoot)];
  assert.ok(catalog.length > 0);
  assert.equal(catalog.every((entry) => FIXTURE_KINDS.has(entry.fixtureKind)), true);
  assert.equal(loadFixturesByKind(recoveryRoot, "recovery").every((entry) => entry.fixtureKind === "recovery"), true);

  const compiledFixtures = loadCompiledFixtures(root);
  assert.ok(compiledFixtures.length > 0);
  const idFactory = (() => { let id = 0; return () => `fixture-${++id}`; })();
  for (const { fixture, filePath } of compiledFixtures) {
    const result = runCompiledFixture(fixture, { config: createMemoryTestConfig(), idFactory }, { filePath });
    assert.equal(result.results.every((entry) => entry.outcome === "committable"), true);
  }
});

test("Harness rejects fixture kinds that it does not understand", () => {
  assert.throws(
    () => validateFixture({ name: "legacy", fixtureKind: "proposal" }),
    /unsupported fixtureKind proposal/,
  );
  assert.throws(() => loadFixturesByKind(__dirname, "proposal"), /Unsupported fixtureKind proposal/);
});
