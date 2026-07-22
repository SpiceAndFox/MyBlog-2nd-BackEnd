const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SCHEMA_VERSION,
  TARGETS,
  assertMemoryState,
  createInitialMemoryState,
  validateCompiledProposal,
} = require("../contracts");
const { reduceCompiledProposal } = require("../domain/compiledReducer");

const FIXTURE_KINDS = new Set(["compiledReducer", "context", "recovery"]);

function listFixtureFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(rootDir, entry.name);
    return entry.isDirectory() ? listFixtureFiles(fullPath) : entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  }).sort();
}

function isPlainObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const output = isPlainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) output[key] = isPlainObject(value) ? deepMerge(output[key], value) : structuredClone(value);
  return output;
}

function initialStateFor(fixture) {
  const state = deepMerge(createInitialMemoryState(), fixture.initialStatePatch || {});
  assertMemoryState(state);
  return state;
}

function validateCompiledFixture(fixture, filePath) {
  initialStateFor(fixture);
  if (!Array.isArray(fixture.ticks) || !fixture.ticks.length) throw new Error(`${filePath}: ticks must be a non-empty array`);
  fixture.ticks.forEach((tick, index) => {
    const prefix = `${filePath}: ticks[${index}]`;
    if (!isPlainObject(tick.task) || tick.task.schemaVersion !== SCHEMA_VERSION) throw new Error(`${prefix}: task must use schema ${SCHEMA_VERSION}`);
    if (!TARGETS[tick.task.targetKey]) throw new Error(`${prefix}: targetKey is invalid`);
    const validation = validateCompiledProposal(tick.compiledProposal, tick.task);
    if (!validation.ok) throw new Error(`${prefix}: compiled proposal is invalid: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    if (!isPlainObject(tick.expected) || !Object.keys(tick.expected).length) throw new Error(`${prefix}: expected is required`);
  });
  return fixture;
}

function validateFixture(fixture, filePath = "<fixture>") {
  if (!isPlainObject(fixture) || typeof fixture.name !== "string" || !fixture.name.trim()) throw new Error(`${filePath}: named fixture is required`);
  if (!FIXTURE_KINDS.has(fixture.fixtureKind)) throw new Error(`${filePath}: unsupported fixtureKind ${String(fixture.fixtureKind)}`);
  if (fixture.fixtureKind === "compiledReducer") validateCompiledFixture(fixture, filePath);
  return fixture;
}

function loadFixtureCatalog(rootDir) {
  return listFixtureFiles(rootDir).map((filePath) => {
    const fixture = validateFixture(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
    return { filePath, fixture, fixtureKind: fixture.fixtureKind };
  });
}

function loadFixtures(rootDir) {
  return loadFixtureCatalog(rootDir).filter((entry) => entry.fixtureKind === "compiledReducer");
}

function assertTickExpected(actual, tick, prefix = "tick") {
  const expected = tick.expected;
  if (expected.outcome !== undefined) assert.equal(actual.outcome, expected.outcome, `${prefix}.outcome`);
  if (expected.revision !== undefined) assert.equal(actual.state.meta.revision, expected.revision, `${prefix}.revision`);
  if (expected.cursorAfter !== undefined) assert.equal(actual.state.meta.targetCursors[tick.task.targetKey], expected.cursorAfter, `${prefix}.cursorAfter`);
  if (expected.decision !== undefined) assert.equal(actual.events[0]?.decision, expected.decision, `${prefix}.decision`);
  if (expected.stateText !== undefined) {
    const items = [...actual.state.working.todos, ...actual.state.working.standingAgreements, ...actual.state.working.recentEpisodes, ...Object.values(actual.state.longTerm).flat()];
    assert.equal(items.some((item) => item.text === expected.stateText), true, `${prefix}.stateText`);
  }
  if (actual.snapshot) assert.deepEqual(actual.snapshot, actual.state, `${prefix}.snapshot`);
}

function runCompiledFixture(fixture, options = {}, context = {}) {
  let state = initialStateFor(fixture);
  const results = [];
  fixture.ticks.forEach((tick, index) => {
    const actual = reduceCompiledProposal({ state, task: tick.task, proposal: tick.compiledProposal, ...options });
    assertTickExpected(actual, tick, `${context.filePath || fixture.name}: ticks[${index}]`);
    if (actual.outcome === "committable") state = structuredClone(actual.state);
    results.push(actual);
  });
  return { state, results };
}

module.exports = {
  FIXTURE_KINDS,
  listFixtureFiles,
  validateFixture,
  loadFixtureCatalog,
  loadFixtures,
  runCompiledFixture,
  assertTickExpected,
  deepMerge,
};
