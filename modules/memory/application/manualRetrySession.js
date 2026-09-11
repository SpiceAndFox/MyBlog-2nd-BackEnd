const { TARGET_KEYS, LIBRARIAN_TARGET_KEY } = require("../contracts");
const value = (row, snake, camel) => row?.[snake] ?? row?.[camel];

// Called once at the foreground boundary, never by polling or a nested drain.
// Only an explicitly recorded allowance exhaustion can be reopened here.
async function beginManualRetrySession(repositories, retryBudget, userId, presetId, generation) {
  if (typeof repositories.runtime.listTasksForTarget !== "function") throw new Error("Manual retry requires task history access");
  await repositories.withTransaction(async client => {
    const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
    if (state?.meta.sourceGeneration !== generation) throw Object.assign(new Error("Memory generation changed before retry session"), { code: "MEMORY_REBUILD_STALE" });
    if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId, { client })) {
      throw Object.assign(new Error("Memory retry session is blocked by privacy operation"), { code: "MEMORY_PRIVACY_OPERATION_PENDING" });
    }
    for (const targetKey of [...TARGET_KEYS, LIBRARIAN_TARGET_KEY]) {
      const tasks = await repositories.runtime.listTasksForTarget(userId, presetId, targetKey, { client });
      const target = targetKey === LIBRARIAN_TARGET_KEY ? null
        : await repositories.runtime.getTargetStatus(userId, presetId, targetKey, { client, forUpdate: true });
      const superseded = new Set(tasks.map(row => value(row, "predecessor_task_id", "predecessorTaskId")).filter(Boolean));
      const resumed = new Set();
      for (const row of tasks) {
        if (value(row, "target_key", "targetKey") !== targetKey
          || Number(value(row, "source_generation", "sourceGeneration")) !== generation
          || row.status !== "failed" || row.stage !== "retry_budget_exhausted") continue;
        const taskId = value(row, "task_id", "taskId");
        // Historical failures must not become runnable alongside their successors.
        if (superseded.has(taskId)) continue;
        if (targetKey !== LIBRARIAN_TARGET_KEY
          && (target?.status !== "halted" || value(target, "last_task_id", "lastTaskId") !== taskId)) continue;
        await repositories.runtime.updateTask(taskId, { status: "queued", stage: "resumed", not_before: null }, { client });
        resumed.add(taskId);
        const task = value(row, "task_payload", "taskPayload")?.task;
        await repositories.runtime.appendOpsLog({ user_id: userId, preset_id: presetId, source_generation: generation,
          task_id: taskId, tick_id: task?.tickId, target_key: targetKey, proposer: task?.proposer,
          outcome: "manual_retry_session", attempt: Number(row.attempt || 0), detail: { previousReason: value(row, "last_error_reason", "lastErrorReason") } }, { client });
      }
      if (target?.status === "halted" && resumed.has(value(target, "last_task_id", "lastTaskId"))) {
        await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: generation,
          status: "retry_wait", consecutiveErrors: 0, lastErrorReason: value(target, "last_error_reason", "lastErrorReason"),
          lastTaskId: value(target, "last_task_id", "lastTaskId"), nextRetryAt: null }, { client });
      }
    }
  });
  retryBudget.resetScope(userId, presetId);
}

module.exports = { beginManualRetrySession };
