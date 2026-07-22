const crypto = require("node:crypto");
const { SCHEMA_VERSION } = require("../contracts");
const { normalizeLifecycle } = require("../domain/lifecycle");
const { phaseId } = require("./normalWritePipeline");

const HOUSEKEEPING_TARGETS = Object.freeze(["scene", "todos", "episodes"]);

function sceneAnchorMessageId(state) {
  const ids = Object.values(state.current.scene).map((field) => field.updatedAtMessageId).filter(Number.isSafeInteger);
  return ids.length ? Math.max(...ids) : null;
}
function cleanupDedupeKey(state, targetKey, timestamp) {
  const dueBoundary = targetKey === "todos"
    ? state.working.todos.filter((item) => item.status === "active" && item.dueAt && Date.parse(item.dueAt) <= timestamp).map((item) => item.id).sort().join(",")
    : targetKey === "episodes" ? `${state.working.recentEpisodes.length}:${state.meta.revision}` : `${sceneAnchorMessageId(state) ?? 0}:${state.meta.revision}`;
  return `system_cleanup:${state.meta.sourceGeneration}:${targetKey}:${dueBoundary}`;
}

function createMemoryHousekeeping({ repositories, config, enqueueByKey, buildKey = (userId, presetId) => `${userId}:${presetId}`, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
  if (!repositories?.state || !repositories?.source || !repositories.withTransaction) throw new Error("Memory housekeeping dependencies are required");

  async function runTarget(userId, presetId, targetKey) {
    if (!HOUSEKEEPING_TARGETS.includes(targetKey)) throw new Error("Invalid housekeeping target");
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) return { status: "missing_state", targetKey };
      const executionNow = now();
      const timestamp = executionNow.getTime();
      if (!Number.isFinite(timestamp)) throw new Error("Housekeeping clock returned an invalid date");
      let sceneAnchorCreatedAt = null;
      const anchorId = targetKey === "scene" ? sceneAnchorMessageId(state) : null;
      if (anchorId !== null) {
        const rows = await repositories.source.getByIds(userId, presetId, [anchorId], { client });
        sceneAnchorCreatedAt = rows[0]?.createdAt ?? null;
      }
      const normalized = normalizeLifecycle(state, { sceneAnchorCreatedAt }, executionNow.toISOString(), config, { targetKeys: [targetKey] });
      if (!normalized.changed) return { status: "noop", targetKey };
      const taskId = idFactory();
      const groupId = phaseId(taskId, "system_cleanup_commit");
      const nextState = normalized.state;
      nextState.meta.revision = state.meta.revision + 1;
      const task = {
        task_id: taskId, dedupe_key: cleanupDedupeKey(state, targetKey, timestamp), user_id: Number(userId), preset_id: String(presetId), target_key: targetKey,
        source_generation: state.meta.sourceGeneration, task_type: "system_cleanup", parent_task_id: null, predecessor_task_id: null, resume_epoch: 0,
        status: "succeeded", stage: "committed", cursor_before: null, target_message_id: null, base_revision: state.meta.revision,
        task_payload: { now: executionNow.toISOString(), targetKey }, stage_payload: null, attempt: 1, context_expansion_attempt: 0,
        not_before: null, last_error_reason: null, result_revision: nextState.meta.revision,
      };
      const inserted = await repositories.runtime.createTask(task, { client });
      if ((inserted.task_id ?? inserted.taskId) !== taskId) return { status: "duplicate", targetKey, taskId: inserted.task_id ?? inserted.taskId };
      await repositories.state.writeState(userId, presetId, nextState, { client });
      await repositories.audit.insertEventGroup({ event_group_id: groupId, user_id: Number(userId), preset_id: String(presetId), task_id: taskId, target_key: targetKey, source_generation: state.meta.sourceGeneration, schema_version: SCHEMA_VERSION, base_revision: state.meta.revision, result_revision: nextState.meta.revision, cursor_before: null, cursor_after: null, group_kind: "system_cleanup" }, { client });
      await repositories.audit.insertEvents(normalized.events.map((event, index) => ({ event_group_id: groupId, event_index: index, user_id: Number(userId), preset_id: String(presetId), task_id: taskId, tick_id: null, target_key: event.targetKey, section: event.section, event_kind: "system_cleanup", decision: "system_cleanup", patch_id: null, op: null, item_id: event.normalizedOperation.itemId ?? null, result_item_id: null, merged_from_item_ids: null, reject_reason: null, maintenance_task_id: null, patch_summary: null, normalized_operation: event.normalizedOperation, cleanup_type: event.cleanupKind })), { client });
      await repositories.audit.insertSnapshot(userId, presetId, { sourceGeneration: nextState.meta.sourceGeneration, revision: nextState.meta.revision, schemaVersion: SCHEMA_VERSION, state: nextState }, { client });
      return { status: "committed", targetKey, taskId, revision: nextState.meta.revision, events: normalized.events };
    });
  }

  async function runScopeSerial(userId, presetId) {
    const results = [];
    for (const targetKey of HOUSEKEEPING_TARGETS) results.push(await runTarget(userId, presetId, targetKey));
    return results;
  }
  async function runScope(userId, presetId) {
    if (typeof enqueueByKey !== "function") return runScopeSerial(userId, presetId);
    return enqueueByKey(buildKey(userId, presetId), () => runScopeSerial(userId, presetId));
  }
  async function runAll() {
    const scopes = await repositories.state.listInitializedScopes();
    const results = [];
    for (const scope of scopes) results.push({ ...scope, results: await runScope(scope.userId, scope.presetId) });
    return results;
  }
  return Object.freeze({ runTarget, runScope, runAll });
}

module.exports = { createMemoryHousekeeping, cleanupDedupeKey, sceneAnchorMessageId };
