const { createEmptyScene } = require("../contracts/state");
const { measureSection, itemRenderedChars } = require("./capacity");

function clone(value) { return structuredClone(value); }
function cleanup(section, targetKey, cleanupKind, details = {}) {
  return {
    eventKind: "system_cleanup",
    section,
    targetKey,
    decision: "system_cleanup",
    cleanupKind,
    normalizedOperation: { cleanupKind, ...details },
  };
}

function evictOldestOverBudget(state, section, targetKey, cleanupKind, budget, events) {
  const items = state.working[section];
  const candidates = items.filter(item => section !== "todos" || item.status === "active");
  const measured = measureSection(state, section);
  if (!candidates.length || (measured.items <= budget.maxItems && measured.renderedChars <= budget.maxRenderedChars)) return;
  candidates.sort((a, b) => a.createdAtMessageId - b.createdAtMessageId || a.id.localeCompare(b.id));
  for (const oldest of candidates) {
    if (measured.items <= budget.maxItems && measured.renderedChars <= budget.maxRenderedChars) break;
    items.splice(items.findIndex(item => item.id === oldest.id), 1);
    measured.items -= 1;
    measured.renderedChars -= itemRenderedChars(oldest, section);
    events.push(cleanup(section, targetKey, cleanupKind, { itemId: oldest.id }));
  }
}

function normalizeLifecycle(memoryState, anchors, now, config, { targetKeys = ["scene", "todos", "episodes"] } = {}) {
  const state = clone(memoryState);
  const events = [];
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("now must be an ISO timestamp");

  const sceneHasValue = Object.values(state.current.scene).some((field) => field.value !== null);
  if (targetKeys.includes("scene") && sceneHasValue && anchors.sceneAnchorCreatedAt) {
    const expiresAtMs = new Date(anchors.sceneAnchorCreatedAt).getTime() + config.scene.ttlMs;
    if (timestamp >= expiresAtMs) {
      if (state.current.previousScene !== null) events.push(cleanup("scene", "scene", "expired_scene_evicted"));
      state.current.previousScene = { ...clone(state.current.scene), expiredAt: new Date(expiresAtMs).toISOString() };
      state.current.scene = createEmptyScene();
      events.unshift(cleanup("scene", "scene", "scene_expired", { expiredAt: new Date(expiresAtMs).toISOString() }));
    }
  }

  for (const todo of targetKeys.includes("todos") ? state.working.todos : []) {
    if (todo.status === "active" && todo.dueAt && timestamp >= new Date(todo.dueAt).getTime()) {
      todo.status = "overdue";
      todo.becameOverdueAt = todo.dueAt;
      events.push(cleanup("todos", "todos", "todo_became_overdue", { itemId: todo.id, becameOverdueAt: todo.dueAt }));
    }
  }

  // Natural overdue transitions release active capacity before FIFO eviction.
  // Capacity eviction does not imply that the conversation's commitment expired.
  if (targetKeys.includes("todos")) evictOldestOverBudget(state, "todos", "todos", "todo_capacity_evicted", config.sectionBudgets.todos, events);
  if (targetKeys.includes("episodes")) evictOldestOverBudget(state, "recentEpisodes", "episodes", "recent_episode_evicted", config.sectionBudgets.recentEpisodes, events);
  return { state, events, changed: events.length > 0 };
}

function buildEffectiveMemoryView(memoryState, anchors, requestNow, config) {
  const result = normalizeLifecycle(memoryState, anchors, requestNow, config);
  return { view: result.state, needsHousekeeping: result.changed, cleanupEvents: result.events };
}

module.exports = { normalizeLifecycle, buildEffectiveMemoryView };
