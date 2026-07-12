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
    const maintenanceTask = tasks.find((task) => rowValue(task, "task_type", "taskType") === "maintenance" && rowValue(task, "parent_task_id", "parentTaskId"));
    const capacityParent = maintenanceTask && tasks.find((task) => rowValue(task, "task_id", "taskId") === rowValue(maintenanceTask, "parent_task_id", "parentTaskId"));
    const activeCapacityChain = capacityParent && ["capacity_blocked", "replaying_original_proposal", "replay_failed"].includes(rowValue(capacityParent, "stage", "stage"));
    if (CAPACITY_REASONS.has(reason) || activeCapacityChain) {
      if (!pipeline.capacity?.createResumeChild) throw new Error("Capacity maintenance pipeline is unavailable");
      const maintenance = maintenanceTask;
      const parentId = rowValue(maintenance, "parent_task_id", "parentTaskId")
        ?? rowValue(tasks.find((task) => rowValue(task, "task_type", "taskType") === "normal"), "task_id", "taskId");
      const parent = tasks.find((task) => rowValue(task, "task_id", "taskId") === parentId);
      const parentEnvelope = rowValue(parent, "task_payload", "taskPayload");
      const payload = structuredClone(rowValue(parent, "stage_payload", "stagePayload"));
      if (!parentEnvelope?.task || !payload?.blockingViolation) throw new Error("Capacity-blocked parent task is not resumable");
      const resumeEpoch = Number(rowValue(maintenance, "resume_epoch", "resumeEpoch") ?? 0) + 1;
      const child = await repositories.withTransaction(async (client) => {
        const created = await pipeline.capacity.createResumeChild(parentEnvelope, payload.blockingViolation, resumeEpoch, client);
        await repositories.runtime.updateTask(parentId, { status: "running", stage: "capacity_blocked", stage_payload: { ...payload, maintenanceTaskId: created.task.taskId }, last_error_reason: "capacity_blocked" }, { client });
        await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: Number(rowValue(target, "source_generation", "sourceGeneration")), status: "capacity_blocked", consecutiveErrors: 0, lastErrorReason: "capacity_blocked", lastTaskId: parentId, nextRetryAt: null }, { client });
        return created;
      });
      return run ? dispatch(child) : { status: "queued", taskId: child.task.taskId, parentTaskId: parentId, resumed: true };
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
