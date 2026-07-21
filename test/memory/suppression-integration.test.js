const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const memoryDomain = require("../../modules/memory/domain");
const { reduceProposal } = memoryDomain;
const fs = require("node:fs");
const path = require("node:path");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/source-rebuild-suppression.json"), "utf8"));
test("runtime domain no longer exports context-suppression filters", () => {
  assert.equal(memoryDomain.filterRebuiltState, undefined);
  assert.equal(memoryDomain.filterRagChunks, undefined);
  assert.equal(memoryDomain.filterRecall, undefined);
});

test("Reducer accepts an authoritative raw source without a suppression query gate", () => {
  const state = createInitialMemoryState();
  const message = { id: 10, userId: 7, presetId: "companion", role: "user", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: "2026-07-01T00:00:00.000Z" };
  const sectionBudgets = Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
  const result = reduceProposal({
    state,
    task: { taskId: "task", tickId: 1, userId: 7, presetId: "companion", sourceGeneration: 0, baseRevision: 0, targetKey: "worldFacts", cursorBefore: 0, targetMessageId: 10, proposer: "worldFactProposer", mode: "normal", targetSections: ["worldFacts"], observedMessageIds: [10], now: "2026-07-13T00:00:00.000Z" },
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "addItem", value: { text: "旧事实" }, evidenceKind: "long_term_fact", evidenceRefs: [{ messageId: 10, quote: "旧事实" }] }] } } },
    observedMessages: [{ id: 10, role: "user", contentKind: "raw", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: message.createdAt }],
    databaseMessages: [message],
    config: { quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets },
  });
  assert.equal(result.events[0].decision, "accepted");
  assert.equal(result.events[0].rejectReason, null);
  assert.equal(result.state.longTerm.worldFacts.length, 1);
  assert.equal(result.state.meta.targetCursors.worldFacts, 10);
});
