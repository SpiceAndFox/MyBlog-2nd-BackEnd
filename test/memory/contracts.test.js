const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createInitialMemoryState, validateMemoryState, validatePatch, validateProposerOutput } = require("../../modules/memory/contracts");
const { loadFixtures } = require("../../modules/memory/harness/runner");

test("revision zero state satisfies the strict v2 schema", () => {
  const state = createInitialMemoryState();
  assert.deepEqual(validateMemoryState(state), { ok: true, errors: [] });
  assert.equal(state.meta.revision, 0);
});
test("state validator rejects runtime recovery state in semantic meta", () => {
  const state = createInitialMemoryState();
  state.meta.halted = true;
  const result = validateMemoryState(state);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.path).join(" "), /halted/);
});
test("normal proposals cannot use maintenance mergeItems", () => {
  const result = validatePatch({ op: "mergeItems", itemIds: ["a", "b"], value: { text: "x" }, evidenceKind: "memory_compaction" }, "todos");
  assert.equal(result.ok, false);
});
test("scene setField uses a direct string value", () => {
  const result = validatePatch({ op: "setField", path: "location", value: "医院门口", evidenceKind: "scene_change", evidenceRefs: [{ messageId: 1, quote: "到了医院门口" }] }, "scene");
  assert.equal(result.ok, true);
});
test("todo add schema requires actor and requester", () => {
  const result = validatePatch({ op: "addItem", value: { text: "归还橡皮" }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "我会归还" }] }, "todos");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.path).join(" "), /actor/);
});
test("output must exactly cover target sections", () => {
  const task = { tickId: 1, targetKey: "episodes", targetSections: ["recentEpisodes", "milestones"], mode: "normal" };
  const result = validateProposerOutput({ tickId: 1, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" } } }, task);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.path).join(" "), /milestones/);
});
test("phase 1 fixtures load through the harness runner", () => {
  const fixtures = loadFixtures(path.join(__dirname, "../../modules/memory/harness/fixtures"));
  assert.equal(fixtures.length, 1);
});
