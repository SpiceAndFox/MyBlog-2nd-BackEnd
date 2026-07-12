const { TARGETS } = require("../contracts");

const CAPACITY_REASONS = new Set(["capacity_still_exceeded", "unable_to_compact", "compaction_failed", "replay_failed"]);

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createMemoryRecovery({ repositories, pipeline, enqueueByKey, buildKey = (userId, presetId) => `${userId}:${presetId}`, now = () => new Date() } = {}) {
  if (!repositories?.runtime || !repositories.withTransaction || !pipeline?.processEnvelope) throw new Error("Memory recovery dependencies are required");

  async function dispatch(envelope) {
    if (typeof enqueueByKey !== "function") return pipeline.processEnvelope(envelope);
    return enqueueByKey(buildKey(envelope.task.userId, envelope.task.presetId), () => pipeline.processEnvelope(envelope));
  }

  async function recoverPending() {
    const tasks = await repositories.runtime.listRecoverableTasks({ now: now() });
    const results = [];
    for (const task of tasks) {
      const envelope = rowValue(task, "task_payload", "taskPayload");
      if (!envelope?.task) throw new Error(`Recoverable Memory task ${task.task_id ?? task.taskId} has no immutable payload`);
      results.push(await dispatch(envelope));
    }
    return results;
  }

  async function resumeTarget(userId, presetId, targetKey, { run = false } = {}) {
    if (!TARGETS[targetKey]) throw new Error("Invalid Memory target key");
    const tasks = await repositories.runtime.listTasksForTarget(userId, presetId, targetKey);
    const latest = tasks[0];
    if (!latest) throw new Error("No Memory task exists for the requested target");
    const target = await repositories.runtime.getTargetStatus(userId, presetId, targetKey);
    if (!target) throw new Error("Memory target status does not exist");
    const status = rowValue(target, "status", "status");
    const reason = rowValue(target, "last_error_reason", "lastErrorReason") ?? rowValue(latest, "last_error_reason", "lastErrorReason");

    if (status === "retry_wait") {
      const retryTask = tasks.find((task) => rowValue(task, "status", "status") === "retry_wait");
      if (!retryTask) throw new Error("retry_wait target has no recoverable task");
      await repositories.withTransaction(async (client) => {
        await repositories.runtime.updateTask(rowValue(retryTask, "task_id", "taskId"), { status: "queued", stage: "resumed", not_before: null, last_error_reason: null }, { client });
        await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: Number(rowValue(target, "source_generation", "sourceGeneration")), status: "healthy", consecutiveErrors: 0, lastErrorReason: null, lastTaskId: rowValue(retryTask, "task_id", "taskId"), nextRetryAt: null }, { client });
      });
      const envelope = rowValue(retryTask, "task_payload", "taskPayload");
      return run ? dispatch(envelope) : { status: "queued", taskId: envelope.task.taskId, resumed: true };
    }

    if (status !== "halted") throw new Error(`Memory target is not resumable from status ${status}`);
    if (CAPACITY_REASONS.has(reason)) {
      throw new Error("Capacity resume requires the stage 5 maintenance/compaction implementation");
    }

    const definition = TARGETS[targetKey];
    const envelope = await repositories.withTransaction(async (client) => {
      await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: Number(rowValue(target, "source_generation", "sourceGeneration")), status: "healthy", consecutiveErrors: 0, lastErrorReason: null, lastTaskId: rowValue(latest, "task_id", "taskId"), nextRetryAt: null }, { client });
      return pipeline.createTask(userId, presetId, { targetKey, proposer: definition.proposer, targetSections: definition.sections, trigger: { type: "lagThreshold" } }, { client, dedupeSuffix: `resume:${rowValue(latest, "task_id", "taskId")}` });
    });
    return run ? dispatch(envelope) : { status: "queued", taskId: envelope.task.taskId, resumed: true };
  }

  return Object.freeze({ recoverPending, resumeTarget });
}

module.exports = { createMemoryRecovery };
