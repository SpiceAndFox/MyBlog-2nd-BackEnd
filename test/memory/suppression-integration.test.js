const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const memoryDomain = require("../../modules/memory/domain");
const { reduceCompiledProposal } = memoryDomain;
const fs = require("node:fs");
const path = require("node:path");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/source-rebuild.json"), "utf8"));
test("runtime domain no longer exports context-suppression filters", () => {
  assert.equal(memoryDomain.filterRebuiltState, undefined);
  assert.equal(memoryDomain.filterRagChunks, undefined);
  assert.equal(memoryDomain.filterRecall, undefined);
});

test("2.01 Reducer accepts compiled authoritative sourceRefs without a suppression query gate", () => {
  const state = createInitialMemoryState();
  const sectionBudgets = Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
  const result = reduceCompiledProposal({
    state,
    task: { taskId: "task", tickId: 1, userId: 7, presetId: "companion", schemaVersion: "2.01", sourceGeneration: 0, baseRevision: 0, targetKey: "worldFacts", cursorBefore: 0, targetMessageId: 10, proposer: "worldFactProposer", mode: "normal", targetSections: ["worldFacts"], observedMessageIds: [10], now: "2026-07-13T00:00:00.000Z" },
    proposal: { tickId: 1, proposer: "worldFactProposer", sectionResults: { worldFacts: { status: "patches", patches: [{ op: "addItem", value: { text: "旧事实" }, sourceRefs: [fixture.oldSource] }] } } },
    config: { scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets },
  });
  assert.equal(result.events[0].decision, "accepted");
  assert.equal(result.events[0].rejectReason, null);
  assert.equal(result.state.longTerm.worldFacts.length, 1);
  assert.equal(result.state.meta.targetCursors.worldFacts, 10);
});
