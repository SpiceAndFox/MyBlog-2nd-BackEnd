const { TARGET_KEYS, TARGET_STATUSES, TASK_STATUSES, TASK_TYPES } = require("../contracts");
const { normalizeScope, executor } = require("./helpers");

async function createTask(task, { client } = {}) {
  if (!TASK_TYPES.includes(task.task_type) || !TASK_STATUSES.includes(task.status) || !TARGET_KEYS.includes(task.target_key)) throw new Error("Invalid Memory v2 task enum");
  const fields = ["task_id","dedupe_key","user_id","preset_id","target_key","source_generation","task_type","parent_task_id","predecessor_task_id","resume_epoch","status","stage","cursor_before","target_message_id","base_revision","task_payload","stage_payload","attempt","context_expansion_attempt","not_before","last_error_reason","result_revision"];
  const values = fields.map((field) => task[field] ?? null);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_tasks (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) ON CONFLICT (user_id,preset_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *`, values);
  return rows[0];
}
async function getTaskForUpdate(taskId, { client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE task_id=$1 FOR UPDATE`, [taskId]);
  return rows[0] || null;
}
async function listRecoverableTasks({ now = new Date(), client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_tasks WHERE status IN ('queued','running','retry_wait') AND (not_before IS NULL OR not_before <= $1) ORDER BY updated_at,created_at`, [now]);
  return rows;
}
async function getTargetStatuses(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2 ORDER BY target_key`, [scope.userId, scope.presetId]);
  return rows;
}
async function upsertTargetStatus(userId, presetId, status, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!TARGET_KEYS.includes(status.targetKey) || !TARGET_STATUSES.includes(status.status)) throw new Error("Invalid target status");
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_target_status (user_id,preset_id,target_key,source_generation,rebuild_boundary_message_id,status,consecutive_errors,last_error_reason,last_task_id,next_retry_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,preset_id,target_key) DO UPDATE SET source_generation=EXCLUDED.source_generation,rebuild_boundary_message_id=EXCLUDED.rebuild_boundary_message_id,status=EXCLUDED.status,consecutive_errors=EXCLUDED.consecutive_errors,last_error_reason=EXCLUDED.last_error_reason,last_task_id=EXCLUDED.last_task_id,next_retry_at=EXCLUDED.next_retry_at,updated_at=NOW() RETURNING *`, [scope.userId,scope.presetId,status.targetKey,status.sourceGeneration,status.rebuildBoundaryMessageId??null,status.status,status.consecutiveErrors??0,status.lastErrorReason??null,status.lastTaskId??null,status.nextRetryAt??null]);
  return rows[0];
}
async function appendOpsLog(entry, { client } = {}) {
  const fields = ["user_id","preset_id","source_generation","task_id","tick_id","target_key","section","proposer","outcome","attempt","detail"];
  const values = fields.map((field) => entry[field] ?? null);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_ops_log (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, values);
  return rows[0];
}
module.exports = { createTask, getTaskForUpdate, listRecoverableTasks, getTargetStatuses, upsertTargetStatus, appendOpsLog };
