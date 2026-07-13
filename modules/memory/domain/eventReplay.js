const { assertMemoryState, createEmptyScene } = require("../contracts/state");
const { sectionItems } = require("./reducer");

function applySemanticEvent(state, event) {
  const operation = event.normalized_operation ?? event.normalizedOperation;
  if (!operation) return;
  const decision = event.decision;
  const section = event.section;
  if (decision === "accepted") {
    if (operation.op === "setField") {
      const ref = operation.evidenceRefs[0];
      state.current.scene[operation.path] = { value: operation.value, evidenceRef: ref, updatedAtMessageId: ref.messageId };
    } else if (operation.op === "clearField") {
      state.current.scene[operation.path] = { value: null, evidenceRef: null, updatedAtMessageId: null };
    } else {
      const items = sectionItems(state, section);
      if (["completeTodo", "cancelTodo", "expireTodo", "cancelAgreement", "forgetItem"].includes(operation.op)) {
        const index = items.findIndex((item) => item.id === operation.itemId);
        if (index < 0) throw new Error(`Replay item missing: ${operation.itemId}`);
        items.splice(index, 1);
      } else if (operation.op === "addItem") {
        items.push(structuredClone(operation.value));
      } else if (operation.op === "updateItem") {
        const index = items.findIndex((item) => item.id === operation.itemId);
        if (index < 0) throw new Error(`Replay item missing: ${operation.itemId}`);
        items[index] = structuredClone(operation.value);
      } else if (operation.op === "mergeItems") {
        for (const id of operation.itemIds) {
          const index = items.findIndex((item) => item.id === id);
          if (index < 0) throw new Error(`Replay merge source missing: ${id}`);
          items.splice(index, 1);
        }
        items.push(structuredClone(operation.value));
      }
    }
    return;
  }
  if (decision !== "system_cleanup") return;
  if (operation.cleanupKind === "scene_expired") {
    state.current.previousScene = { ...structuredClone(state.current.scene), expiredAt: operation.expiredAt };
    state.current.scene = createEmptyScene();
  } else if (operation.cleanupKind === "expired_scene_evicted") {
    // scene_expired in the same group already replaced the previous value.
  } else if (operation.cleanupKind === "todo_became_overdue") {
    const item = state.working.todos.find((candidate) => candidate.id === operation.itemId);
    if (!item) throw new Error(`Replay todo missing: ${operation.itemId}`);
    item.status = "overdue";
    item.becameOverdueAt = operation.becameOverdueAt;
  } else if (operation.cleanupKind === "todo_revived_from_overdue") {
    const item = state.working.todos.find((candidate) => candidate.id === operation.itemId);
    if (!item) throw new Error(`Replay todo missing: ${operation.itemId}`);
    item.status = "active";
    item.becameOverdueAt = null;
    item.dueAt = operation.dueAt;
  } else if (operation.cleanupKind === "recent_episode_evicted") {
    const index = state.working.recentEpisodes.findIndex((item) => item.id === operation.itemId);
    if (index < 0) throw new Error(`Replay episode missing: ${operation.itemId}`);
    state.working.recentEpisodes.splice(index, 1);
  }
}

function replayEventGroups(anchorState, groups, events) {
  const state = structuredClone(anchorState);
  const byGroup = new Map();
  for (const event of events) {
    const id = event.event_group_id ?? event.eventGroupId;
    const rows = byGroup.get(id) || [];
    rows.push(event);
    byGroup.set(id, rows);
  }
  for (const group of groups) {
    const groupId = group.event_group_id ?? group.eventGroupId;
    for (const event of (byGroup.get(groupId) || []).sort((a, b) => Number(a.event_index ?? a.eventIndex) - Number(b.event_index ?? b.eventIndex))) applySemanticEvent(state, event);
    state.meta.revision = Number(group.result_revision ?? group.resultRevision);
    const targetKey = group.target_key ?? group.targetKey;
    const cursorAfter = group.cursor_after ?? group.cursorAfter;
    if (cursorAfter !== null && cursorAfter !== undefined) state.meta.targetCursors[targetKey] = Number(cursorAfter);
  }
  assertMemoryState(state);
  return state;
}

module.exports = { applySemanticEvent, replayEventGroups };
