const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assertMemoryState, TARGET_KEYS, validateTaskEnvelope, validateProposerOutput } = require("../contracts");
const { reduceProposal } = require("../domain/reducer");
const { renderMemory } = require("../domain/renderer");

const TARGET_STATUSES = new Set(["healthy", "retry_wait", "capacity_blocked", "halted", "rebuilding"]);
const FIXTURE_KINDS = new Set(["reducer", "pipeline", "context", "recovery"]);
const EXPECTED_KEYS = new Set([
  "outcome", "revision", "cursorAfter", "decision", "stateText",
  "statePatch", "events", "eventGroup", "snapshot", "task", "targetStatus",
  "opsLog", "cursor", "meta", "renderEquals", "renderContains", "adapterError",
]);

function listFixtureFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(rootDir, entry.name);
    return entry.isDirectory() ? listFixtureFiles(fullPath) : entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  }).sort();
}

function formatErrors(errors) { return errors.map((entry) => `${entry.path} ${entry.message}`).join("; "); }
function isPlainObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function validateExpected(expected, prefix) {
  if (!isPlainObject(expected) || !Object.keys(expected).length) throw new Error(`${prefix}: expected must be a non-empty object`);
  for (const key of Object.keys(expected)) {
    if (!EXPECTED_KEYS.has(key)) throw new Error(`${prefix}: unsupported expected field ${key}`);
  }
  if (expected.events !== undefined && !Array.isArray(expected.events)) throw new Error(`${prefix}: expected.events must be an array`);
  if (expected.opsLog !== undefined && !Array.isArray(expected.opsLog)) throw new Error(`${prefix}: expected.opsLog must be an array`);
  if (expected.renderContains !== undefined && typeof expected.renderContains !== "string" && !Array.isArray(expected.renderContains)) {
    throw new Error(`${prefix}: expected.renderContains must be a string or array`);
  }
}

function validateFixture(fixture, filePath = "<fixture>") {
  if (!isPlainObject(fixture)) throw new Error(`${filePath}: fixture must be an object`);
  if (typeof fixture.name !== "string" || !fixture.name.trim()) throw new Error(`${filePath}: name is required`);
  assertMemoryState(fixture.initialState);
  if (fixture.initialState.meta.revision === 0 && Object.values(fixture.initialState.meta.targetCursors).some((cursor) => cursor !== 0)) {
    throw new Error(`${filePath}: revision zero fixture cursors must be zero`);
  }
  if (fixture.initialState.meta.revision !== 0 && !fixture.generationBoundarySnapshot) throw new Error(`${filePath}: advanced initial state requires generationBoundarySnapshot`);
  const statuses = fixture.initialTargetStatuses;
  if (!isPlainObject(statuses)) throw new Error(`${filePath}: initialTargetStatuses is required`);
  for (const targetKey of TARGET_KEYS) {
    const status = statuses[targetKey];
    if (!isPlainObject(status)) throw new Error(`${filePath}: missing initial target status ${targetKey}`);
    if (status.sourceGeneration !== fixture.initialState.meta.sourceGeneration) throw new Error(`${filePath}: ${targetKey} status generation mismatch`);
    if (!TARGET_STATUSES.has(status.status)) throw new Error(`${filePath}: initial ${targetKey} status is invalid`);
    if (!Number.isSafeInteger(status.consecutiveErrors) || status.consecutiveErrors < 0) throw new Error(`${filePath}: initial ${targetKey} consecutiveErrors is invalid`);
  }
  if (!Array.isArray(fixture.ticks) || !fixture.ticks.length) throw new Error(`${filePath}: ticks must be a non-empty array`);
  fixture.ticks.forEach((tick, index) => {
    const prefix = `${filePath}: ticks[${index}]`;
    const envelopeResult = validateTaskEnvelope(tick.input);
    if (!envelopeResult.ok) throw new Error(`${prefix} invalid input: ${formatErrors(envelopeResult.errors)}`);
    if (!tick.adapterMock || !["ok", "error"].includes(tick.adapterMock.status)) throw new Error(`${prefix}: adapterMock status is invalid`);
    if (tick.adapterMock.status === "ok") {
      const outputResult = validateProposerOutput(tick.adapterMock.output, tick.input.task);
      if (!outputResult.ok) throw new Error(`${prefix} invalid output: ${formatErrors(outputResult.errors)}`);
    } else if (typeof tick.adapterMock.reason !== "string" || !tick.adapterMock.reason) {
      throw new Error(`${prefix}: adapterMock error reason is required`);
    }
    validateExpected(tick.expected, prefix);
  });
  return fixture;
}

function loadFixtureCatalog(rootDir) {
  return listFixtureFiles(rootDir).map((filePath) => {
    const fixture = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const fixtureKind = fixture.fixtureKind;
    if (!FIXTURE_KINDS.has(fixtureKind)) throw new Error(`${filePath}: fixtureKind must be one of ${[...FIXTURE_KINDS].join(", ")}`);
    if (["reducer", "pipeline"].includes(fixtureKind)) validateFixture(fixture, filePath);
    else if (typeof fixture.name !== "string" || !fixture.name.trim()) throw new Error(`${filePath}: named support fixture is required`);
    return { filePath, fixture, fixtureKind };
  });
}

function loadFixtures(rootDir) {
  return loadFixtureCatalog(rootDir)
    .filter((entry) => entry.fixtureKind === "reducer")
    .map(({ filePath, fixture }) => ({ filePath, fixture }));
}

function matcherMatches(actual, matcher) {
  if (matcher._match === "notNull") return actual !== null && actual !== undefined;
  if (matcher._match === "string") return typeof actual === "string" && (matcher.prefix === undefined || actual.startsWith(matcher.prefix));
  return false;
}

function assertMatch(actual, expected, label = "value") {
  if (isPlainObject(expected) && Object.prototype.hasOwnProperty.call(expected, "_match")) {
    assert.equal(matcherMatches(actual, expected), true, `${label} did not satisfy matcher ${JSON.stringify(expected)}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(Array.isArray(actual), true, `${label} must be an array`);
    assert.equal(actual.length, expected.length, `${label} row count differs`);
    expected.forEach((entry, index) => assertMatch(actual[index], entry, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(expected)) {
    assert.equal(isPlainObject(actual), true, `${label} must be an object`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(Object.prototype.hasOwnProperty.call(actual, key), true, `${label}.${key} is missing`);
      assertMatch(actual[key], value, `${label}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `${label} differs`);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const output = isPlainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) output[key] = isPlainObject(value) ? deepMerge(output[key], value) : structuredClone(value);
  return output;
}

function normalizeReducerActual(result, tick) {
  const task = tick.input.task;
  return {
    ...result,
    cursor: { [task.targetKey]: result.state?.meta?.targetCursors?.[task.targetKey] ?? task.cursorBefore ?? null },
    meta: result.state?.meta,
    snapshot: result.snapshot ? { sourceGeneration: result.snapshot.meta.sourceGeneration, revision: result.snapshot.meta.revision, state: result.snapshot } : null,
    adapterError: null,
  };
}

function field(row, camel, snake = camel) { return row?.[camel] ?? row?.[snake]; }

function assertDurableInvariants(actual, prefix) {
  if (actual.snapshot) {
    const snapshotState = field(actual.snapshot, "state");
    assert.deepEqual(snapshotState, actual.state, `${prefix}.snapshot.state must equal final state`);
    const snapshotRevision = Number(field(actual.snapshot, "revision"));
    assert.equal(snapshotRevision, actual.state.meta.revision, `${prefix}.snapshot revision must equal state revision`);
  }
  if (actual.eventGroup && field(actual.eventGroup, "resultRevision", "result_revision") !== null && field(actual.eventGroup, "resultRevision", "result_revision") !== undefined) {
    assert.equal(Number(field(actual.eventGroup, "resultRevision", "result_revision")), actual.state.meta.revision, `${prefix}.eventGroup result revision must equal state revision`);
    assert.equal(Number(field(actual.eventGroup, "cursorAfter", "cursor_after")), actual.cursor?.[field(actual.eventGroup, "targetKey", "target_key")], `${prefix}.eventGroup cursor must equal state cursor`);
  }
  if (actual.task && field(actual.task, "status") === "succeeded") {
    assert.equal(Number(field(actual.task, "resultRevision", "result_revision")), actual.state.meta.revision, `${prefix}.task result revision must equal state revision`);
  }
}

function executeReducerTick(fixture, tick, options = {}, state = fixture.initialState) {
  if (tick.adapterMock.status === "error") {
    return {
      outcome: "adapter_error",
      state: structuredClone(state),
      events: [],
      snapshot: null,
      cursor: { [tick.input.task.targetKey]: state.meta.targetCursors[tick.input.task.targetKey] ?? 0 },
      meta: structuredClone(state.meta),
      adapterError: { reason: tick.adapterMock.reason, detail: tick.adapterMock.detail ?? null },
    };
  }
  return normalizeReducerActual(reduceProposal({
    state,
    task: tick.input.task,
    proposal: tick.adapterMock.output,
    observedMessages: tick.input.observedMessages,
    databaseMessages: tick.databaseMessages || [],
    ...options,
  }), tick);
}

function assertTickExpected(actual, tick, { fixture, filePath = "<fixture>", tickIndex = 0, config, goldenRoot } = {}) {
  const expected = tick.expected;
  const prefix = `${filePath}: ticks[${tickIndex}]`;
  assertDurableInvariants(actual, prefix);
  if (expected.outcome !== undefined) assert.equal(actual.outcome, expected.outcome, `${prefix}.outcome`);
  if (expected.revision !== undefined) assert.equal(actual.state?.meta?.revision, expected.revision, `${prefix}.revision`);
  if (expected.cursorAfter !== undefined) assert.equal(actual.cursor?.[tick.input.task.targetKey], expected.cursorAfter, `${prefix}.cursorAfter`);
  if (expected.decision !== undefined) assert.equal(actual.events?.[0]?.decision, expected.decision, `${prefix}.decision`);
  if (expected.stateText !== undefined) {
    const items = [...(actual.state?.working?.todos || []), ...(actual.state?.working?.standingAgreements || []), ...(actual.state?.working?.recentEpisodes || []), ...Object.values(actual.state?.longTerm || {}).flat()];
    assert.equal(items.some((item) => item.text === expected.stateText), true, `${prefix}.stateText`);
  }
  if (expected.statePatch !== undefined) assertMatch(actual.state, deepMerge(fixture.initialState, expected.statePatch), `${prefix}.statePatch`);
  if (expected.events !== undefined) assertMatch(actual.events, expected.events, `${prefix}.events`);
  for (const key of ["eventGroup", "snapshot", "task", "targetStatus", "opsLog", "cursor", "meta", "adapterError"]) {
    if (expected[key] !== undefined) assertMatch(actual[key], expected[key], `${prefix}.${key}`);
  }
  if (expected.renderEquals !== undefined && expected.renderEquals !== null) {
    if (!config) throw new Error(`${prefix}: renderer assertions require config`);
    const rendered = renderMemory({ state: actual.state, requestNow: tick.input.task.now, config }).renderedText;
    const root = goldenRoot || path.join(__dirname, "golden");
    const expectedText = fs.readFileSync(path.resolve(root, expected.renderEquals), "utf8").trimEnd();
    assert.equal(rendered, expectedText, `${prefix}.renderEquals`);
  }
  if (expected.renderContains !== undefined) {
    if (!config) throw new Error(`${prefix}: renderer assertions require config`);
    const rendered = renderMemory({ state: actual.state, requestNow: tick.input.task.now, config }).renderedText;
    for (const fragment of [].concat(expected.renderContains)) assert.equal(rendered.includes(fragment), true, `${prefix}.renderContains missing ${fragment}`);
  }
  return actual;
}

function runReducerFixture(fixture, options = {}, context = {}) {
  let state = structuredClone(fixture.initialState);
  const results = [];
  fixture.ticks.forEach((tick, tickIndex) => {
    const actual = executeReducerTick(fixture, tick, options, state);
    assertTickExpected(actual, tick, { fixture, tickIndex, config: options.config, ...context });
    if (actual.outcome === "committable") state = structuredClone(actual.state);
    results.push(actual);
  });
  return { state, results };
}

module.exports = {
  FIXTURE_KINDS, listFixtureFiles, validateFixture, loadFixtureCatalog, loadFixtures, executeReducerTick, runReducerFixture,
  assertTickExpected, assertDurableInvariants, assertMatch, deepMerge,
};
