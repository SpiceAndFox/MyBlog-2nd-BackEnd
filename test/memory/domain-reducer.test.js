const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createInitialMemoryState, TARGETS } = require("../../modules/memory/contracts");
const { loadFixtures, executeReducerTick } = require("../../modules/memory/harness/runner");
const { reduceProposal } = require("../../modules/memory/domain");

function budgets(maxItems = 20, maxRenderedChars = 2000) {
  return Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems, maxRenderedChars }]));
}
const config = { quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets: budgets() };
function sequence(...values) { let index = 0; return () => values[index++] || `id-${index}`; }
function task(targetKey, overrides = {}) {
  return {
    tickId: 1, taskId: "task", userId: 1, presetId: "p", schemaVersion: 2, sourceGeneration: 0, baseRevision: 0,
    targetKey, cursorBefore: 0, targetMessageId: 2, proposer: TARGETS[targetKey].proposer, mode: "normal",
    targetSections: TARGETS[targetKey].sections, observedMessageIds: [2], now: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}
function message(id, role, content, createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, userId: 1, presetId: "p", role, createdAt, contentHash: `sha256:${id}`, content };
}
function observed(database) { const { userId, presetId, content, ...value } = database; return { ...value, contentKind: "raw", content }; }
function item(id, text, messageId = 1, todo = false) {
  const value = { id, text, evidenceGroups: [{ evidenceKind: todo ? "user_commitment" : "long_term_fact", refs: [{ messageId, contentHash: `sha256:${messageId}`, quote: text }] }], createdAtMessageId: messageId, updatedAtMessageId: messageId };
  return todo ? { ...value, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: null } : value;
}

test("stage 2 reducer fixture produces accepted event, snapshot, provenance, and cursor", () => {
  const loaded = loadFixtures(path.join(__dirname, "../../modules/memory/harness/fixtures"));
  const { fixture } = loaded.find((entry) => entry.fixture.name === "todo-add-with-valid-evidence");
  const result = executeReducerTick(fixture, fixture.ticks[0], { config, idFactory: sequence("patch-1", "1") });
  assert.equal(result.outcome, "committable");
  assert.equal(result.events[0].decision, "accepted");
  assert.equal(result.state.working.todos[0].id, "todo:1");
  assert.equal(result.state.working.todos[0].evidenceGroups[0].refs[0].contentHash, fixture.ticks[0].databaseMessages[0].contentHash);
  assert.equal(result.state.meta.targetCursors.todos, 121);
  assert.deepEqual(result.snapshot, result.state);
});

test("ordinary rejected and noop proposals still yield a cursor-only revision", () => {
  const database = message(2, "user", "只是普通的一天，没有里程碑");
  const state = createInitialMemoryState();
  const rejectedResult = reduceProposal({
    state, task: task("episodes"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: {
      recentEpisodes: { status: "noop" },
      milestones: { status: "patches", patches: [{ op: "addItem", value: { text: "普通一天" }, evidenceKind: "recent_episode", evidenceRefs: [{ messageId: 2, quote: "普通的一天" }] }] },
    } }, idFactory: sequence("patch"),
  });
  assert.deepEqual(rejectedResult.events.map((event) => event.decision), ["noop", "rejected"]);
  assert.equal(rejectedResult.events[1].rejectReason, "policy_not_allowed");
  assert.equal(rejectedResult.state.meta.revision, 1);
  assert.equal(rejectedResult.state.meta.targetCursors.episodes, 2);
});

test("role mismatches are rejected before policy application", () => {
  const database = message(2, "assistant", "请忘记我的旧名字");
  const state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:old", "旧名字"));
  const result = reduceProposal({ state, task: task("worldFacts"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "forgetItem", itemId: "worldFact:old", evidenceKind: "user_forget", evidenceRefs: [{ messageId: 2, quote: "忘记我的旧名字" }] }] } } }, idFactory: sequence("patch") });
  assert.equal(result.events[0].rejectReason, "evidence_role_mismatch");
  assert.equal(result.state.longTerm.worldFacts.length, 1);
});

test("correction preserves item identity, appends evidence, and suppresses replaced sources", () => {
  const database = message(2, "user", "更正一下，我住在上海");
  const state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:home", "住在北京"));
  const result = reduceProposal({ state, task: task("worldFacts"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "updateItem", itemId: "worldFact:home", value: { text: "住在上海" }, evidenceKind: "user_correction", evidenceRefs: [{ messageId: 2, quote: "我住在上海" }] }] } } }, idFactory: sequence("patch") });
  const updated = result.state.longTerm.worldFacts[0];
  assert.equal(updated.id, "worldFact:home");
  assert.equal(updated.evidenceGroups.length, 2);
  assert.deepEqual(result.tombstones, [{ messageId: 1, contentHash: "sha256:1", reason: "correction", sourceItemId: "worldFact:home", sourceSection: "worldFacts", userId: 1, presetId: "p", createdRevision: 1 }]);
  assert.equal(result.tombstones.some((entry) => entry.messageId === 2), false);
});

test("capacity violation atomically defers the triggering patch", () => {
  const database = message(2, "user", "我们约定以后不冷战");
  const state = createInitialMemoryState();
  state.working.standingAgreements.push(item("agreement:1", "先说明情绪"));
  const tight = { ...config, sectionBudgets: { ...config.sectionBudgets, standingAgreements: { maxItems: 1, maxRenderedChars: 2000 } } };
  const result = reduceProposal({ state, task: task("standingAgreements"), observedMessages: [observed(database)], databaseMessages: [database], config: tight,
    proposal: { sectionResults: { standingAgreements: { status: "patches", patches: [{ op: "addItem", value: { text: "不冷战" }, evidenceKind: "standing_agreement", evidenceRefs: [{ messageId: 2, quote: "约定以后不冷战" }] }] } } }, idFactory: sequence("patch", "2") });
  assert.equal(result.outcome, "deferred");
  assert.equal(result.events[0].decision, "deferred");
  assert.equal(result.capacityViolation.dimension, "maxItems");
  assert.deepEqual(result.state, state);
  assert.equal(result.snapshot, null);
});

test("overdue todo can only revive through a future set dueChange", () => {
  const database = message(2, "user", "改到明天再去赴约");
  const state = createInitialMemoryState();
  state.working.todos.push({ ...item("todo:1", "赴约", 1, true), status: "overdue", becameOverdueAt: "2025-12-31T00:00:00.000Z", dueAt: "2025-12-31T00:00:00.000Z" });
  const patch = { op: "updateItem", itemId: "todo:1", value: { dueChange: { mode: "set", dueAt: { mode: "relative", days: 1 } } }, evidenceKind: "user_correction", evidenceRefs: [{ messageId: 2, quote: "明天再去赴约" }] };
  const result = reduceProposal({ state, task: task("todos"), observedMessages: [observed(database)], databaseMessages: [database], config, proposal: { sectionResults: { todos: { status: "patches", patches: [patch] } } }, idFactory: sequence("patch") });
  assert.equal(result.state.working.todos[0].status, "active");
  assert.equal(result.state.working.todos[0].becameOverdueAt, null);
  assert.equal(result.cleanupEvents[0].cleanupKind, "todo_revived_from_overdue");
});

test("maintenance merge is accepted for every compactable item section", () => {
  for (const section of ["todos", "standingAgreements", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"]) {
    const state = createInitialMemoryState();
    const targetKey = Object.entries(TARGETS).find(([, target]) => target.sections.includes(section))[0];
    section === "todos" || section === "standingAgreements" ? state.working[section].push(item(`${section}:1`, "甲", 1, section === "todos"), item(`${section}:2`, "乙", 2, section === "todos")) : state.longTerm[section].push(item(`${section}:1`, "甲", 1), item(`${section}:2`, "乙", 2));
    const maintenanceTask = task(targetKey, { mode: "maintenance", proposer: "compactionProposer", targetSections: [section], observedMessageIds: [], cursorBefore: undefined, targetMessageId: 2 });
    const result = reduceProposal({ state, task: maintenanceTask, observedMessages: [], databaseMessages: [], config,
      proposal: { sectionResults: { [section]: { status: "patches", patches: [{ op: "mergeItems", itemIds: [`${section}:1`, `${section}:2`], value: { text: "甲乙" }, evidenceKind: "memory_compaction" }] } } }, idFactory: sequence("patch", "merged") });
    assert.equal(result.events[0].decision, "accepted", section);
    assert.deepEqual(result.events[0].mergedFromItemIds, [`${section}:1`, `${section}:2`]);
    assert.equal(result.events[0].resultItemId.endsWith(":merged"), true);
  }
});
