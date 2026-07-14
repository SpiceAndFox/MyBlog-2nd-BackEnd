const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createInitialMemoryState, validateMemoryState, validatePatch, validateProposerOutput, validateTaskEnvelope } = require("../../modules/memory/contracts");

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
test("state validator rejects malformed persisted provenance and todo lifecycle", () => {
  const state = createInitialMemoryState();
  state.working.todos.push({
    id: "todo:1", text: "还书", actor: "user", requester: "user", status: "overdue",
    dueAt: null, becameOverdueAt: "2026", createdAtMessageId: 1, updatedAtMessageId: 2,
    evidenceGroups: [{ evidenceKind: "memory_compaction", refs: [{ messageId: 7, contentHash: "sha256:x", quote: "q".repeat(201) }] }],
  });
  const result = validateMemoryState(state);
  assert.equal(result.ok, false);
  const paths = result.errors.map((entry) => entry.path).join(" ");
  assert.match(paths, /contentHash/);
  assert.match(paths, /createdAtMessageId/);
  assert.match(paths, /dueAt/);
});
test("task envelope validator rejects mismatched target mappings and observed hashes", () => {
  const content = "你好";
  const envelope = {
    task: {
      taskId: "00000000-0000-4000-8000-000000000001", tickId: 1, userId: 1, presetId: "default",
      schemaVersion: 2, sourceGeneration: 0, baseRevision: 0, targetKey: "todos", cursorBefore: 0,
      targetMessageId: 1, proposer: "currentStateProposer", mode: "normal", targetSections: ["scene"],
      observedMessageIds: [1], trigger: { type: "lagThreshold" }, now: "2026-07-12T00:00:00Z", userTimeZone: "UTC",
    },
    writableState: {}, readOnlyContext: {},
    observedMessages: [{ id: 1, role: "user", createdAt: "2026-07-12T00:00:00Z", contentKind: "raw", content, contentHash: `sha256:${crypto.createHash("sha256").update("different").digest("hex")}` }],
  };
  const result = validateTaskEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => `${entry.path}:${entry.message}`).join(" "), /proposer|targetSections|contentHash/);
});
test("normal proposals cannot use maintenance mergeItems", () => {
  const result = validatePatch({ op: "mergeItems", itemIds: ["a", "b"], value: { text: "x" }, evidenceKind: "memory_compaction" }, "todos");
  assert.equal(result.ok, false);
});
test("scene setField uses a direct string value", () => {
  const result = validatePatch({ op: "setField", path: "location", value: "医院门口", evidenceKind: "scene_change", evidenceRefs: [{ messageId: 1, quote: "到了医院门口" }] }, "scene");
  assert.equal(result.ok, true);
});
test("scene patch validator reports null evidence refs without throwing", () => {
  const result = validatePatch({ op: "setField", path: "location", value: "医院门口", evidenceKind: "scene_change", evidenceRefs: null }, "scene");
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.path === "$.evidenceRefs" && error.message === "must be a non-empty array"), true);
});
test("todo add schema requires actor and requester", () => {
  const result = validatePatch({ op: "addItem", value: { text: "归还橡皮" }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "我会归还" }] }, "todos");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.path).join(" "), /actor/);
});
test("todo due date rejects impossible calendar dates", () => {
  const result = validatePatch({ op: "addItem", value: { text: "赴约", actor: "user", requester: "user", dueAt: { mode: "absolute", date: "2026-02-31" } }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "月底去赴约" }] }, "todos");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.message).join(" "), /valid YYYY-MM-DD/);
});
test("output must exactly cover target sections", () => {
  const task = { tickId: 1, targetKey: "episodes", targetSections: ["recentEpisodes", "milestones"], mode: "normal" };
  const result = validateProposerOutput({ tickId: 1, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" } } }, task);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((entry) => entry.path).join(" "), /milestones/);
});
