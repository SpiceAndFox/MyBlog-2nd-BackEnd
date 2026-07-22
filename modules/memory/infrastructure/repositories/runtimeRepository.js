const { TARGET_KEYS, TARGET_STATUSES, TASK_STATUSES, TASK_TYPES } = require("../../contracts");
const { normalizeScope, executor, withTransaction } = require("./helpers");

async function createTask(task, { client } = {}) {
  if (!TASK_TYPES.includes(task.task_type) || !TASK_STATUSES.includes(task.status) || !TARGET_KEYS.includes(task.target_key)) throw new Error("Invalid Memory v2 task enum");
  const fields = ["task_id","dedupe_key","user_id","preset_id","target_key","source_generation","schema_version","task_type","parent_task_id","predecessor_task_id","resume_epoch","status","stage","cursor_before","target_message_id","base_revision","task_payload","stage_payload","attempt","context_expansion_attempt","not_before","last_error_reason","result_revision"];
  const values = fields.map((field) => task[field] ?? null);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_tasks (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) ON CONFLICT (user_id,preset_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *`, values);
  return rows[0];
}
async function getTaskForUpdate(taskId, { client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE task_id=$1 FOR UPDATE`, [taskId]);
  return rows[0] || null;
}
async function getTask(taskId, { client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE task_id=$1`, [taskId]);
  return rows[0] || null;
}
async function updateTask(taskId, changes, { client } = {}) {
  const allowed = ["status", "stage", "stage_payload", "attempt", "context_expansion_attempt", "not_before", "last_error_reason", "result_revision"];
  const fields = Object.keys(changes);
  if (!fields.length || fields.some((field) => !allowed.includes(field))) throw new Error("Invalid Memory task update fields");
  const assignments = fields.map((field, index) => `${field}=$${index + 2}`).join(",");
  const { rows } = await executor(client).query(`UPDATE chat_memory_tasks SET ${assignments},updated_at=NOW() WHERE task_id=$1 RETURNING *`, [taskId, ...fields.map((field) => changes[field])]);
  if (!rows[0]) throw new Error("Memory task not found");
  return rows[0];
}
async function listRecoverableTasks({ now = new Date(), client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE status IN ('queued','running','retry_wait') AND (not_before IS NULL OR not_before <= $1) ORDER BY updated_at,created_at`, [now]);
  return rows;
}
async function listPendingTasks({ client } = {}) {
  const { rows } = await executor(client).query(`SELECT task_id,status,not_before,user_id,preset_id,target_key FROM chat_memory_tasks WHERE status IN ('queued','running','retry_wait') ORDER BY updated_at,created_at`);
  return rows;
}
async function getTargetStatus(userId, presetId, targetKey, { client, forUpdate = false } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!TARGET_KEYS.includes(targetKey)) throw new Error("Invalid target key");
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2 AND target_key=$3${forUpdate ? " FOR UPDATE" : ""}`, [scope.userId, scope.presetId, targetKey]);
  return rows[0] || null;
}
async function listTasksForTarget(userId, presetId, targetKey, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!TARGET_KEYS.includes(targetKey)) throw new Error("Invalid target key");
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE user_id=$1 AND preset_id=$2 AND target_key=$3 ORDER BY updated_at DESC,created_at DESC`, [scope.userId, scope.presetId, targetKey]);
  return rows;
}
async function getTargetStatuses(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2 ORDER BY target_key`, [scope.userId, scope.presetId]);
  return rows;
}
async function upsertTargetStatus(userId, presetId, status, { client } = {}) {
  if (!client) return withTransaction((transactionClient) => upsertTargetStatus(userId, presetId, status, { client: transactionClient }));
  const scope = normalizeScope(userId, presetId);
  if (!TARGET_KEYS.includes(status.targetKey) || !TARGET_STATUSES.includes(status.status)) throw new Error("Invalid target status");
  const db = executor(client);
  const { rows: priorRows } = await db.query(`SELECT status,rebuild_boundary_message_id FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2 AND target_key=$3 FOR UPDATE`, [scope.userId,scope.presetId,status.targetKey]);
  const rebuildBoundaryMessageId = Object.prototype.hasOwnProperty.call(status, "rebuildBoundaryMessageId")
    ? status.rebuildBoundaryMessageId
    : (priorRows[0]?.rebuild_boundary_message_id ?? null);
  const { rows } = await db.query(`INSERT INTO chat_memory_target_status (user_id,preset_id,target_key,source_generation,rebuild_boundary_message_id,status,consecutive_errors,last_error_reason,last_task_id,next_retry_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,preset_id,target_key) DO UPDATE SET source_generation=EXCLUDED.source_generation,rebuild_boundary_message_id=EXCLUDED.rebuild_boundary_message_id,status=EXCLUDED.status,consecutive_errors=EXCLUDED.consecutive_errors,last_error_reason=EXCLUDED.last_error_reason,last_task_id=EXCLUDED.last_task_id,next_retry_at=EXCLUDED.next_retry_at,updated_at=NOW() RETURNING *`, [scope.userId,scope.presetId,status.targetKey,status.sourceGeneration,rebuildBoundaryMessageId,status.status,status.consecutiveErrors??0,status.lastErrorReason??null,status.lastTaskId??null,status.nextRetryAt??null]);
  if (priorRows[0] && priorRows[0].status !== "healthy" && status.status === "healthy") {
    const { rows: taskRows } = status.lastTaskId ? await db.query(`SELECT status FROM chat_memory_tasks WHERE task_id=$1`, [status.lastTaskId]) : { rows: [] };
    if (taskRows[0]?.status === "succeeded") {
      const { rows: stateRows } = await db.query(`SELECT memory_state FROM chat_preset_memory WHERE user_id=$1 AND preset_id=$2`, [scope.userId,scope.presetId]);
      const boundary = Number(stateRows[0]?.memory_state?.meta?.targetCursors?.[status.targetKey] ?? 0);
      await db.query(`INSERT INTO chat_memory_recovery_notifications (user_id,preset_id,subject_kind,subject_key,notification_type,boundary_message_id,source_generation) VALUES ($1,$2,'target',$3,'recovered',$4,$5) ON CONFLICT (user_id,preset_id,subject_kind,subject_key,notification_type,source_generation,boundary_message_id) DO NOTHING`, [scope.userId,scope.presetId,status.targetKey,Number.isSafeInteger(boundary) && boundary >= 0 ? boundary : 0,status.sourceGeneration]);
    }
  }
  return rows[0];
}
async function appendOpsLog(entry, { client } = {}) {
  const fields = ["user_id","preset_id","source_generation","task_id","tick_id","target_key","section","proposer","outcome","attempt","detail"];
  const values = fields.map((field) => entry[field] ?? null);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_ops_log (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, values);
  return rows[0];
}
async function cancelNonTerminalTasks(userId, presetId, olderThanGeneration, reason, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`UPDATE chat_memory_tasks SET status='cancelled',stage='stale',last_error_reason=$4,updated_at=NOW() WHERE user_id=$1 AND preset_id=$2 AND source_generation<$3 AND status IN ('queued','running','retry_wait') RETURNING task_id`, [scope.userId, scope.presetId, olderThanGeneration, reason]);
  return rows;
}
async function deleteRetainedRuntime(userId, presetId, { taskBefore, opsBefore }, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const taskResult = await db.query(`DELETE FROM chat_memory_tasks t WHERE t.user_id=$1 AND t.preset_id=$2 AND t.updated_at<$3 AND t.status IN ('succeeded','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM chat_memory_tasks active WHERE active.user_id=t.user_id AND active.preset_id=t.preset_id AND active.status IN ('queued','running','retry_wait') AND (active.task_id=t.task_id OR active.parent_task_id=t.task_id OR active.predecessor_task_id=t.task_id)) AND NOT EXISTS (SELECT 1 FROM chat_memory_event_groups g WHERE g.task_id=t.task_id)`, [scope.userId, scope.presetId, taskBefore]);
  const opsResult = await db.query(`DELETE FROM chat_memory_ops_log WHERE user_id=$1 AND preset_id=$2 AND created_at<$3 AND task_id NOT IN (SELECT task_id FROM chat_memory_tasks WHERE user_id=$1 AND preset_id=$2)`, [scope.userId, scope.presetId, opsBefore]);
  return { tasks: taskResult.rowCount || 0, ops: opsResult.rowCount || 0 };
}
async function recordSuccessfulTargetTask(userId, presetId, { targetKey, sourceGeneration, taskId }, { client } = {}) {
  const prior = await getTargetStatus(userId, presetId, targetKey, { client, forUpdate: true });
  const rebuilding = prior && prior.status === "rebuilding" && Number(prior.source_generation ?? prior.sourceGeneration) === sourceGeneration;
  return upsertTargetStatus(userId, presetId, {
    targetKey, sourceGeneration, status: rebuilding ? "rebuilding" : "healthy",
    rebuildBoundaryMessageId: rebuilding ? Number(prior.rebuild_boundary_message_id ?? prior.rebuildBoundaryMessageId) : null,
    consecutiveErrors: 0, lastErrorReason: null, lastTaskId: taskId, nextRetryAt: null,
  }, { client });
}
module.exports = { createTask, getTask, getTaskForUpdate, updateTask, listRecoverableTasks, listPendingTasks, getTargetStatus, getTargetStatuses, listTasksForTarget, upsertTargetStatus, recordSuccessfulTargetTask, appendOpsLog, cancelNonTerminalTasks, deleteRetainedRuntime };
