const crypto = require("node:crypto");
const { SCHEMA_VERSION, validateProposerOutput } = require("../contracts");
const { reduceProposal } = require("../domain/reducer");
const { buildNormalEnvelope, normalDedupeKey } = require("./envelope");

function phaseId(taskId, phase = "normal_commit") {
  const hex = crypto.createHash("sha256").update(`${taskId}:${phase}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function taskRow(envelope) {
  const task = envelope.task;
  return {
    task_id: task.taskId, dedupe_key: normalDedupeKey(task), user_id: task.userId, preset_id: task.presetId,
    target_key: task.targetKey, source_generation: task.sourceGeneration, task_type: "normal",
    parent_task_id: null, predecessor_task_id: null, resume_epoch: 0, status: "queued", stage: "proposing",
    cursor_before: task.cursorBefore, target_message_id: task.targetMessageId, base_revision: task.baseRevision,
    task_payload: envelope, stage_payload: null, attempt: 0, context_expansion_attempt: 0,
    not_before: null, last_error_reason: null, result_revision: null,
  };
}
function rowValue(row, snake, camel) { return row[snake] ?? row[camel]; }
function mapEvent(event, envelope, eventGroupId, index) {
  const task = envelope.task;
  return {
    event_group_id: eventGroupId, event_index: index, user_id: task.userId, preset_id: task.presetId,
    task_id: task.taskId, tick_id: task.tickId, target_key: event.targetKey, section: event.section,
    event_kind: event.eventKind, decision: event.decision, patch_id: event.patchId, op: event.op,
    item_id: event.itemId, result_item_id: event.resultItemId, merged_from_item_ids: event.mergedFromItemIds,
    evidence_kind: event.evidenceKind, reject_reason: event.rejectReason, maintenance_task_id: null,
    patch_summary: event.patchSummary ?? null, normalized_operation: event.normalizedOperation,
    cleanup_type: event.cleanupKind ?? null,
  };
}

function createNormalWritePipeline({ observer, providerAdapter, repositories, config, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
  if (!observer || !providerAdapter || !repositories?.source || !repositories.withTransaction) throw new Error("Normal Memory pipeline dependencies are required");

  async function createTask(userId, presetId, intent) {
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) throw new Error("Memory state must be initialized before creating normal tasks");
      const cursorBefore = state.meta.targetCursors[intent.targetKey] ?? 0;
      const targetConfig = config.targets[intent.targetKey];
      const messages = await repositories.source.getObservedWindow(userId, presetId, cursorBefore, {
        newBatchSize: targetConfig.lagThreshold,
        contextWindow: targetConfig.contextWindow,
      }, { client });
      const envelope = buildNormalEnvelope({
        userId, presetId, state,
        intent: { ...intent, cursorBefore },
        messages, now: now(), config,
      });
      const row = await repositories.runtime.createTask(taskRow(envelope), { client });
      return rowValue(row, "task_payload", "taskPayload") ?? envelope;
    });
  }

  async function recordAdapterError(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before provider error persistence");
      const persistent = adapterResult.reason === "output_schema_invalid";
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: persistent ? "failed" : "retry_wait", stage: "provider_error",
        attempt: Number(task.attempt) + 1, last_error_reason: adapterResult.reason,
      }, { client });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration,
        status: persistent ? "halted" : "retry_wait", consecutiveErrors: Number(task.attempt) + 1,
        lastErrorReason: adapterResult.reason, lastTaskId: envelope.task.taskId,
      }, { client });
      await repositories.runtime.appendOpsLog({
        user_id: envelope.task.userId, preset_id: envelope.task.presetId, source_generation: envelope.task.sourceGeneration,
        task_id: envelope.task.taskId, tick_id: envelope.task.tickId, target_key: envelope.task.targetKey,
        proposer: envelope.task.proposer, outcome: adapterResult.reason, attempt: Number(task.attempt) + 1,
        detail: adapterResult.detail ?? null,
      }, { client });
      return adapterResult;
    });
  }

  async function commit(envelope, output) {
    const outputValidation = validateProposerOutput(output, envelope.task);
    if (!outputValidation.ok) return recordAdapterError(envelope, { status: "error", reason: "output_schema_invalid", detail: { errors: outputValidation.errors } });
    if (Object.values(output.sectionResults).some((result) => result.status === "unable_to_decide")) {
      return { status: "unable_to_decide", taskId: envelope.task.taskId };
    }
    return repositories.withTransaction(async (client) => {
      const groupId = phaseId(envelope.task.taskId);
      const existing = await repositories.audit.getEventGroup(groupId, { client });
      if (existing) return { status: "committed", taskId: envelope.task.taskId, revision: Number(existing.result_revision), duplicate: true };
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found during commit");
      if (["succeeded", "failed", "cancelled"].includes(task.status)) return { status: task.status, taskId: envelope.task.taskId, revision: task.result_revision ? Number(task.result_revision) : null, duplicate: true };
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration || (state.meta.targetCursors[envelope.task.targetKey] ?? 0) !== envelope.task.cursorBefore) return { status: "stale", taskId: envelope.task.taskId };
      if (state.meta.revision !== envelope.task.baseRevision) return { status: "successor_required", taskId: envelope.task.taskId };
      const databaseMessages = await repositories.source.getByIds(envelope.task.userId, envelope.task.presetId, envelope.task.observedMessageIds, { client });
      const reduction = reduceProposal({ state, task: envelope.task, proposal: output, observedMessages: envelope.observedMessages, databaseMessages, now: envelope.task.now, config, idFactory });
      if (reduction.outcome === "deferred") return { status: "capacity_deferred", taskId: envelope.task.taskId, reduction };
      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertEventGroup({
        event_group_id: groupId, user_id: envelope.task.userId, preset_id: envelope.task.presetId,
        task_id: envelope.task.taskId, target_key: envelope.task.targetKey, source_generation: envelope.task.sourceGeneration,
        schema_version: SCHEMA_VERSION, base_revision: state.meta.revision, result_revision: reduction.state.meta.revision,
        cursor_before: envelope.task.cursorBefore, cursor_after: envelope.task.targetMessageId, group_kind: "proposal",
      }, { client });
      await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEvent(event, envelope, groupId, index)), { client });
      for (const tombstone of reduction.tombstones) await repositories.sidecars.insertTombstone(envelope.task.userId, envelope.task.presetId, tombstone, { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, {
        sourceGeneration: reduction.state.meta.sourceGeneration, revision: reduction.state.meta.revision,
        schemaVersion: SCHEMA_VERSION, state: reduction.snapshot,
      }, { client });
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "succeeded", stage: "committed", result_revision: reduction.state.meta.revision, last_error_reason: null }, { client });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration, status: "healthy",
        consecutiveErrors: 0, lastErrorReason: null, lastTaskId: envelope.task.taskId, nextRetryAt: null,
      }, { client });
      return { status: "committed", taskId: envelope.task.taskId, revision: reduction.state.meta.revision, events: reduction.events };
    });
  }

  async function processIntent(userId, presetId, intent) {
    const envelope = await createTask(userId, presetId, intent);
    const adapterResult = await providerAdapter.propose(envelope);
    if (adapterResult.status === "error") return recordAdapterError(envelope, adapterResult);
    return commit(envelope, adapterResult.output);
  }
  async function processScope(userId, presetId) {
    const observation = await observer.observe(userId, presetId);
    const results = [];
    for (const intent of observation.eligibleTasks) results.push(await processIntent(userId, presetId, intent));
    return results;
  }
  return Object.freeze({ processScope, processIntent, createTask, commit });
}

module.exports = { createNormalWritePipeline, phaseId, taskRow, mapEvent };
