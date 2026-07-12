const fs = require("node:fs");
const path = require("node:path");
const { assertMemoryState, TARGET_KEYS, validateTaskEnvelope, validateProposerOutput } = require("../../../services/chat/memory-v2/contracts");

function listFixtureFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(rootDir, entry.name);
    return entry.isDirectory() ? listFixtureFiles(fullPath) : entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  }).sort();
}

function formatErrors(errors) { return errors.map((entry) => `${entry.path} ${entry.message}`).join("; "); }

function validateFixture(fixture, filePath = "<fixture>") {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error(`${filePath}: fixture must be an object`);
  if (typeof fixture.name !== "string" || !fixture.name.trim()) throw new Error(`${filePath}: name is required`);
  assertMemoryState(fixture.initialState);
  if (fixture.initialState.meta.revision !== 0 && !fixture.generationBoundarySnapshot) throw new Error(`${filePath}: advanced initial state requires generationBoundarySnapshot`);
  const statuses = fixture.initialTargetStatuses;
  if (!statuses || typeof statuses !== "object") throw new Error(`${filePath}: initialTargetStatuses is required`);
  for (const targetKey of TARGET_KEYS) {
    const status = statuses[targetKey];
    if (!status) throw new Error(`${filePath}: missing initial target status ${targetKey}`);
    if (status.sourceGeneration !== fixture.initialState.meta.sourceGeneration) throw new Error(`${filePath}: ${targetKey} status generation mismatch`);
    if (status.status !== "healthy" || status.consecutiveErrors !== 0) throw new Error(`${filePath}: initial ${targetKey} status must be healthy with zero errors`);
  }
  if (!Array.isArray(fixture.ticks)) throw new Error(`${filePath}: ticks must be an array`);
  fixture.ticks.forEach((tick, index) => {
    const prefix = `${filePath}: ticks[${index}]`;
    const envelopeResult = validateTaskEnvelope(tick.input);
    if (!envelopeResult.ok) throw new Error(`${prefix} invalid input: ${formatErrors(envelopeResult.errors)}`);
    if (!tick.adapterMock || !["ok", "error"].includes(tick.adapterMock.status)) throw new Error(`${prefix}: adapterMock status is invalid`);
    if (tick.adapterMock.status === "ok") {
      const outputResult = validateProposerOutput(tick.adapterMock.output, tick.input.task);
      if (!outputResult.ok) throw new Error(`${prefix} invalid output: ${formatErrors(outputResult.errors)}`);
    }
    if (!tick.expected || typeof tick.expected !== "object") throw new Error(`${prefix}: expected is required`);
  });
  return fixture;
}

function loadFixtures(rootDir) {
  return listFixtureFiles(rootDir).map((filePath) => ({ filePath, fixture: validateFixture(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath) }));
}

module.exports = { listFixtureFiles, validateFixture, loadFixtures };
