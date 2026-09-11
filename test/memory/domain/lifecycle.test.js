const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { resolveDueAt, normalizeLifecycle, buildEffectiveMemoryView } = require("../../../modules/memory/domain");

const config = {
  scene: { ttlMs: 60_000, maxRenderedChars: 1000 },
  sectionBudgets: { todos: { maxItems: 2, maxRenderedChars: 1000 }, recentEpisodes: { maxItems: 2, maxRenderedChars: 20 } },
};
const ref = { messageId: 1, contentHash: `sha256:${"a".repeat(64)}` };
const item = (id, text, messageId) => ({ id, text, sourceRefs: [{ ...ref, messageId }], createdAtMessageId: messageId, updatedAtMessageId: messageId });
const todo = (id, messageId, extra = {}) => ({ ...item(id, "约定", messageId), actor: "user", requester: "user", status: "active", dueAt: null, becameOverdueAt: null, ...extra });

test("todo capacity evicts by creation and stable id, ignoring update recency", () => {
  const state = createInitialMemoryState();
  state.working.todos = [todo("todo:b", 1), todo("todo:c", 2), todo("todo:a", 1, { updatedAtMessageId: 10 })];
  const original = structuredClone(state);
  const result = normalizeLifecycle(state, {}, "2026-07-13T00:00:00Z", config);
  assert.deepEqual(result.state.working.todos.map(item => item.id), ["todo:b", "todo:c"]);
  assert.deepEqual(result.events.map(event => event.normalizedOperation), [{ cleanupKind: "todo_capacity_evicted", itemId: "todo:a" }]);
  assert.deepEqual(state, original);
  assert.equal(normalizeLifecycle(result.state, {}, "2026-07-13T00:00:00Z", config).changed, false);
  assert.deepEqual(normalizeLifecycle(state, {}, "2026-07-13T00:00:00Z", config, { targetKeys: ["episodes"] }).state, original);
  const effective = buildEffectiveMemoryView(state, {}, "2026-07-13T00:00:00Z", config);
  assert.deepEqual(effective.view, result.state);
  assert.equal(effective.needsHousekeeping, true);
});

test("natural overdue transitions release capacity before eviction", () => {
  const state = createInitialMemoryState();
  state.working.todos = [todo("todo:old", 1), todo("todo:due", 2, { dueAt: "2026-07-13T00:00:00.000Z" }), todo("todo:new", 3)];
  const result = normalizeLifecycle(state, {}, "2026-07-13T00:00:00Z", config);
  assert.equal(result.state.working.todos.length, 3);
  assert.equal(result.state.working.todos[1].status, "overdue");
  assert.deepEqual(result.events.map(event => event.cleanupKind), ["todo_became_overdue"]);
});

test("todo eviction fits both budgets and counts actor, requester, due date and Unicode code points", () => {
  const state = createInitialMemoryState();
  state.working.todos = [
    todo("todo:overdue", 0, { status: "overdue", dueAt: "2026-01-01T00:00:00.000Z", becameOverdueAt: "2026-01-01T00:00:00.000Z" }),
    todo("todo:old", 1), todo("todo:middle", 2),
    todo("todo:new", 3, { text: "😀", actor: "assistant", dueAt: "2027-01-01T00:00:00.000Z" }),
  ];
  // 1 code point + 9 actor + 4 requester + 24 dueAt = 38.
  const budgetConfig = { ...config, sectionBudgets: { ...config.sectionBudgets, todos: { maxItems: 2, maxRenderedChars: 38 } } };
  const result = normalizeLifecycle(state, {}, "2026-07-13T00:00:00Z", budgetConfig);
  assert.deepEqual(result.state.working.todos.map(item => item.id), ["todo:overdue", "todo:new"]);
  assert.deepEqual(result.events.map(event => event.normalizedOperation.itemId), ["todo:old", "todo:middle"]);
  budgetConfig.sectionBudgets.todos.maxRenderedChars = 37;
  const tooLarge = normalizeLifecycle(result.state, {}, "2026-07-13T00:00:00Z", budgetConfig);
  assert.deepEqual(tooLarge.state.working.todos.map(item => item.id), ["todo:overdue"]);
});

test("dueAt calendar arithmetic honors user time zone and month-end clamping", () => {
  assert.equal(resolveDueAt({ mode: "absolute", date: "2026-07-07" }, null, "Asia/Shanghai"), "2026-07-07T16:00:00.000Z");
  assert.equal(resolveDueAt({ mode: "relative", days: 0 }, "2026-07-15T02:30:00.000Z", "Asia/Shanghai"), "2026-07-15T16:00:00.000Z");
  assert.equal(resolveDueAt({ mode: "relative", months: 1 }, "2026-01-31T04:00:00.000Z", "Asia/Shanghai"), "2026-02-28T16:00:00.000Z");
  assert.equal(resolveDueAt({ mode: "relative", days: 1 }, "2026-02-07T07:30:00.500Z", "America/New_York"), "2026-02-09T05:00:00.000Z");
  assert.equal(resolveDueAt({ mode: "relative", months: 1 }, "2026-02-08T07:30:00.000Z", "America/New_York"), "2026-03-09T04:00:00.000Z");
});

test("today todo stays active until the user's next local day boundary", () => {
  const state = createInitialMemoryState();
  state.working.todos.push({ id: "todo:today", text: "今天完成", sourceRefs: [ref], createdAtMessageId: 1, updatedAtMessageId: 1, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: "2026-07-15T16:00:00.000Z" });
  assert.equal(normalizeLifecycle(state, {}, "2026-07-15T15:59:59.999Z", config).state.working.todos[0].status, "active");
  const overdue = normalizeLifecycle(state, {}, "2026-07-15T16:00:00.000Z", config);
  assert.equal(overdue.state.working.todos[0].status, "overdue");
  assert.equal(overdue.events[0].cleanupKind, "todo_became_overdue");
});

test("scene expiration preserves provenance, evicts previous scene, and is idempotent", () => {
  const state = createInitialMemoryState();
  state.current.scene.location = { value: "屋顶", sourceRefs: [ref], updatedAtMessageId: 1 };
  state.current.previousScene = { ...structuredClone(state.current.scene), expiredAt: "2025-01-01T00:00:00.000Z" };
  const first = normalizeLifecycle(state, { sceneAnchorCreatedAt: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:01:00.000Z", config);
  assert.equal(first.state.current.scene.location.value, null);
  assert.equal(first.state.current.previousScene.location.value, "屋顶");
  assert.deepEqual(first.events.map((event) => event.cleanupKind), ["scene_expired", "expired_scene_evicted"]);
  assert.deepEqual(first.events.map((event) => event.decision), ["system_cleanup", "system_cleanup"]);
  assert.equal(normalizeLifecycle(first.state, {}, "2026-01-02T00:00:00.000Z", config).changed, false);
});

test("todo becomes overdue in place exactly once", () => {
  const state = createInitialMemoryState();
  state.working.todos.push({ id: "todo:1", text: "赴约", sourceRefs: [ref], createdAtMessageId: 1, updatedAtMessageId: 1, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: "2026-01-01T00:00:00.000Z" });
  const first = normalizeLifecycle(state, {}, "2026-01-01T00:00:00.000Z", config);
  assert.equal(first.state.working.todos[0].status, "overdue");
  assert.equal(first.events[0].cleanupKind, "todo_became_overdue");
  assert.equal(first.events[0].decision, "system_cleanup");
  assert.equal(normalizeLifecycle(first.state, {}, "2026-01-02T00:00:00.000Z", config).changed, false);
});

test("recent episodes deterministically roll out by created message id and item id", () => {
  const state = createInitialMemoryState();
  state.working.recentEpisodes.push(item("episode:b", "旧事B", 1), item("episode:a", "旧事A", 1), item("episode:c", "新事", 2));
  const result = normalizeLifecycle(state, {}, "2026-01-01T00:00:00.000Z", config);
  assert.deepEqual(result.state.working.recentEpisodes.map((entry) => entry.id), ["episode:b", "episode:c"]);
  assert.equal(result.events[0].normalizedOperation.itemId, "episode:a");
});

test("effective view reports housekeeping without mutating authority", () => {
  const state = createInitialMemoryState();
  state.current.scene.mood = { value: "紧张", sourceRefs: [ref], updatedAtMessageId: 1 };
  const result = buildEffectiveMemoryView(state, { sceneAnchorCreatedAt: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:01:00.000Z", config);
  assert.equal(result.needsHousekeeping, true);
  assert.equal(result.view.current.scene.mood.value, null);
  assert.equal(state.current.scene.mood.value, "紧张");
});
