const { LIBRARIAN_TARGET_KEY, TARGETS } = require("../contracts");
const { isSemanticTaskEnvelope } = require("./envelope");

const CAPACITY_REASONS = new Set(["capacity_still_exceeded", "unable_to_compact", "compaction_failed", "replay_failed"]);

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function isForceDrainEnvelope(envelope) { return envelope?.task?.trigger?.type === "forceDrain"; }

function createMemoryRecovery({ repositories, pipeline, librarianPipeline, enqueueByKey, metrics, onDispatchError, buildKey = (userId, presetId) => `${userId}:${presetId}`, now = () => new Date() } = {}) {
  if (!repositories?.runtime || !repositories.withTransaction || !pipeline?.processEnvelope) throw new Error("Memory recovery dependencies are required");

  async function dispatch(envelope) {
    const selected = envelope?.task?.targetKey === LIBRARIAN_TARGET_KEY ? librarianPipeline : pipeline;
    if (!selected?.processEnvelope) throw new Error(`Memory pipeline is unavailable for ${envelope?.task?.targetKey}`);
    if (typeof enqueueByKey !== "function") return selected.processEnvelope(envelope);
    return enqueueByKey(buildKey(envelope.task.userId, envelope.task.presetId), async (options) => {
      if (await repositories.privacy?.hasIncompleteOperation?.(envelope.task.userId, envelope.task.presetId)) {
        return { status: "skipped", reason: "privacy_delete_pending" };
      }
      if (repositories.state?.getState) {
        const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId);
        if (!state || state.meta.sourceGeneration !== envelope.task.sourceGeneration) {
          return { status: "stale", reason: "generation_mismatch", taskId: envelope.task.taskId };
        }
      }
      return selected.processEnvelope(envelope, options);
    });
  }

  async function isRebuildManaged(envelope) {
    if (envelope?.task?.targetKey === LIBRARIAN_TARGET_KEY && String(envelope?.task?.triggerType || "").startsWith("rebuild")) return true;
    if (isForceDrainEnvelope(envelope)) return true;
    const parentTaskId = envelope?.task?.parentTaskId;
    if (!parentTaskId || typeof repositories.runtime.getTask !== "function") return false;
    const parent = await repositories.runtime.getTask(parentTaskId);
    return isForceDrainEnvelope(rowValue(parent, "task_payload", "taskPayload"));
  }

  async function recoverPending() {
    const tasks = await repositories.runtime.listRecoverableTasks({ now: now() });
    metrics?.observe("memory_task_backlog", {}, tasks.length);
    const results = [];
    for (const task of tasks) {
      const status = rowValue(task, "status", "status") ?? "unknown";
      metrics?.increment("memory_task_recovery_dispatch_total", { status, targetKey: rowValue(task, "target_key", "targetKey") ?? "unknown" });
      const createdAt = rowValue(task, "created_at", "createdAt");
      if (createdAt) metrics?.observe("memory_task_queue_age_ms", { status }, Math.max(0, now().getTime() - new Date(createdAt).getTime()));
      const envelope = rowValue(task, "task_payload", "taskPayload");
      if (!envelope?.task) throw new Error(`Recoverable Memory task ${task.task_id ?? task.taskId} has no immutable payload`);
      if (await isRebuildManaged(envelope)) {
        results.push({ status: "rebuild_managed", taskId: envelope.task.taskId, targetKey: envelope.task.targetKey });
        continue;
      }
      try {
        const result = await dispatch(envelope);
        results.push(envelope.task.targetKey === LIBRARIAN_TARGET_KEY ? { ...result, targetKey: LIBRARIAN_TARGET_KEY } : result);
      } catch (error) {
        metrics?.increment("memory_task_recovery_dispatch_errors_total", { status, targetKey: envelope.task.targetKey });
        onDispatchError?.(error, envelope.task);
        results.push({ status: "dispatch_failed", taskId: envelope.task.taskId, error });
      }
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
      const envelope = rowValue(retryTask, "task_payload", "taskPayload");
      if (!isSemanticTaskEnvelope(envelope)) {
        const error = new Error("Memory 2.01 cannot resume a legacy retry task");
        error.code = "MEMORY_V201_CUTOVER_REQUIRED";
        throw error;
      }
      await repositories.withTransaction(async (client) => {
        await repositories.runtime.updateTask(rowValue(retryTask, "task_id", "taskId"), { status: "queued", stage: "resumed", not_before: null, last_error_reason: reason }, { client });
        await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: Number(rowValue(target, "source_generation", "sourceGeneration")), status: "retry_wait", consecutiveErrors: Number(rowValue(target, "consecutive_errors", "consecutiveErrors") ?? 0), lastErrorReason: reason, lastTaskId: rowValue(retryTask, "task_id", "taskId"), nextRetryAt: null }, { client });
      });
      return run ? dispatch(envelope) : { status: "queued", taskId: envelope.task.taskId, resumed: true };
    }

    if (status !== "halted") throw new Error(`Memory target is not resumable from status ${status}`);
    const maintenanceTask = tasks.find((task) => rowValue(task, "task_type", "taskType") === "maintenance" && rowValue(task, "parent_task_id", "parentTaskId"));
    const capacityParent = maintenanceTask && tasks.find((task) => rowValue(task, "task_id", "taskId") === rowValue(maintenanceTask, "parent_task_id", "parentTaskId"));
    const activeCapacityChain = capacityParent && ["capacity_blocked", "replaying_original_proposal", "replay_failed"].includes(rowValue(capacityParent, "stage", "stage"));
    if (CAPACITY_REASONS.has(reason) || activeCapacityChain) {
      if (!pipeline.capacity?.resumeParent) throw new Error("Capacity maintenance pipeline is unavailable");
      const maintenance = maintenanceTask;
      const parentId = rowValue(maintenance, "parent_task_id", "parentTaskId")
        ?? rowValue(tasks.find((task) => rowValue(task, "task_type", "taskType") === "normal"), "task_id", "taskId");
      const parent = tasks.find((task) => rowValue(task, "task_id", "taskId") === parentId);
      const parentEnvelope = rowValue(parent, "task_payload", "taskPayload");
      if (!isSemanticTaskEnvelope(parentEnvelope)) {
        const error = new Error("Memory 2.01 cannot resume a legacy capacity task");
        error.code = "MEMORY_V201_CUTOVER_REQUIRED";
        throw error;
      }
      const payload = rowValue(parent, "stage_payload", "stagePayload");
      if (!payload?.blockingViolation) throw new Error("Capacity-blocked parent task is not resumable");
      const resumeEpoch = Number(rowValue(maintenance, "resume_epoch", "resumeEpoch") ?? 0) + 1;
      const reassessed = await pipeline.capacity.resumeParent(parentEnvelope, { resumeEpoch });
      if (!reassessed?.maintenanceEnvelope) return { ...reassessed, resumed: true };
      const child = reassessed.maintenanceEnvelope;
      return run
        ? dispatch(child)
        : { status: "queued", taskId: child.task.taskId, parentTaskId: parentId, resumed: true };
    }

    const definition = TARGETS[targetKey];
    const envelope = await repositories.withTransaction(async (client) => {
      return pipeline.createTask(userId, presetId, { targetKey, proposer: definition.proposer, targetSections: definition.sections, trigger: { type: "lagThreshold" } }, { client, dedupeSuffix: `resume:${rowValue(latest, "task_id", "taskId")}` });
    });
    return run ? dispatch(envelope) : { status: "queued", taskId: envelope.task.taskId, resumed: true };
  }

  return Object.freeze({ recoverPending, resumeTarget });
}

module.exports = { createMemoryRecovery };
