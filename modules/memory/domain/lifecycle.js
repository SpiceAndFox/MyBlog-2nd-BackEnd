const { createEmptyScene } = require("../contracts/state");
const { createEmptySceneV201, MEMORY_CONTROL_V201_SCHEMA_VERSION } = require("../contracts/stateV201");
const { measureSection } = require("./capacity");

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
      state.current.scene = state.version === MEMORY_CONTROL_V201_SCHEMA_VERSION ? createEmptySceneV201() : createEmptyScene();
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

  const budget = config.sectionBudgets.recentEpisodes;
  const episodes = state.working.recentEpisodes;
  const oldestFirst = () => episodes.slice().sort((a, b) => a.createdAtMessageId - b.createdAtMessageId || a.id.localeCompare(b.id));
  while (targetKeys.includes("episodes") && (episodes.length > budget.maxItems || measureSection(state, "recentEpisodes").renderedChars > budget.maxRenderedChars)) {
    const oldest = oldestFirst()[0];
    if (!oldest) break;
    episodes.splice(episodes.findIndex((item) => item.id === oldest.id), 1);
    events.push(cleanup("recentEpisodes", "episodes", "recent_episode_evicted", { itemId: oldest.id }));
  }
  return { state, events, changed: events.length > 0 };
}

function buildEffectiveMemoryView(memoryState, anchors, requestNow, config) {
  const result = normalizeLifecycle(memoryState, anchors, requestNow, config);
  return { view: result.state, needsHousekeeping: result.changed, cleanupEvents: result.events };
}

module.exports = { normalizeLifecycle, buildEffectiveMemoryView };
