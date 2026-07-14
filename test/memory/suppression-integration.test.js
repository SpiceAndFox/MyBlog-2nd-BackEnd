const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { filterRebuiltState, filterRagChunks, filterRecall, reduceProposal } = require("../../modules/memory/domain");
const fs = require("node:fs");
const path = require("node:path");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/source-rebuild-suppression.json"), "utf8"));
const ref = (source, quote = "证据") => ({ ...source, quote });
const group = (evidenceKind, source) => ({ evidenceKind, refs: [ref(source)] });
const item = (id, groups) => ({ id, text: id, evidenceGroups: groups, createdAtMessageId: groups[0].refs[0].messageId, updatedAtMessageId: Math.max(...groups.flatMap((entry) => entry.refs.map((entryRef) => entryRef.messageId))) });

test("rebuild terminal suppression removes forgotten candidates but preserves a later correction", () => {
  const state = createInitialMemoryState();
  state.longTerm.userProfile.push(
    item("forgotten", [group("long_term_fact", fixture.oldSource)]),
    item("corrected", [group("long_term_fact", fixture.oldSource), group("user_correction", fixture.correctionSource)]),
  );
  const tombstones = [{ ...fixture.oldSource, reason: "forget" }];
  const filtered = filterRebuiltState(state, tombstones);
  assert.deepEqual(filtered.removedItemIds, ["forgotten"]);
  assert.deepEqual(filtered.state.longTerm.userProfile.map((entry) => entry.id), ["corrected"]);
  state.current.previousScene = { ...structuredClone(state.current.scene), expiredAt: "2026-07-02T00:00:00.000Z" };
  state.current.previousScene.location = { value: "旧地点", evidenceRef: ref(fixture.oldSource), updatedAtMessageId: fixture.oldSource.messageId };
  const sceneFiltered = filterRebuiltState(state, tombstones);
  assert.equal(sceneFiltered.state.current.previousScene.location.value, null);
  assert.equal(sceneFiltered.state.current.previousScene.expiredAt, state.current.previousScene.expiredAt);

  const chunks = filterRagChunks([
    { id: 1, metadata: { sourceRefs: [fixture.oldSource] } },
    { id: 2, metadata: { sourceRefs: [fixture.correctionSource] } },
  ], tombstones);
  assert.deepEqual(chunks.map((entry) => entry.id), [2]);

  const recall = filterRecall({
    evidenceGroups: [group("long_term_fact", fixture.oldSource), group("user_correction", fixture.correctionSource)],
    rawMessages: [{ id: 10, contentHash: fixture.oldSource.contentHash }, { id: 20, contentHash: fixture.correctionSource.contentHash }],
  }, tombstones);
  assert.deepEqual(recall.rawMessages.map((entry) => entry.id), [20]);
  assert.deepEqual(recall.evidenceGroups.map((entry) => entry.evidenceKind), ["user_correction"]);
});

test("Reducer rejects a proposal after the suppression query gate removes its source", () => {
  const state = createInitialMemoryState();
  const message = { id: 10, userId: 7, presetId: "companion", role: "user", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: "2026-07-01T00:00:00.000Z" };
  const sectionBudgets = Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
  const result = reduceProposal({
    state,
    task: { taskId: "task", tickId: 1, userId: 7, presetId: "companion", sourceGeneration: 0, baseRevision: 0, targetKey: "worldFacts", cursorBefore: 0, targetMessageId: 10, proposer: "worldFactProposer", mode: "normal", targetSections: ["worldFacts"], observedMessageIds: [10], now: "2026-07-13T00:00:00.000Z" },
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "addItem", value: { text: "旧事实" }, evidenceKind: "long_term_fact", evidenceRefs: [{ messageId: 10, quote: "旧事实" }] }] } } },
    observedMessages: [{ id: 10, role: "user", contentKind: "raw", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: message.createdAt }],
    databaseMessages: [],
    config: { quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets },
  });
  assert.equal(result.events[0].decision, "rejected");
  assert.equal(result.events[0].rejectReason, "message_id_not_found");
  assert.equal(result.state.longTerm.worldFacts.length, 0);
  assert.equal(result.state.meta.targetCursors.worldFacts, 10);
});

