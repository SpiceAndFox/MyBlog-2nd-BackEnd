const { normalizeScope, executor } = require("./helpers");

async function purgeDerivedHistory(userId, presetId, { client, preserveTombstones = true } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const params = [scope.userId, scope.presetId];
  const counts = {};
  for (const [name, sql] of [
    ["events", `DELETE FROM chat_memory_events WHERE user_id=$1 AND preset_id=$2`],
    ["eventGroups", `DELETE FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2`],
    ["snapshots", `DELETE FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2`],
    ["tasks", `DELETE FROM chat_memory_tasks WHERE user_id=$1 AND preset_id=$2`],
    ["ops", `DELETE FROM chat_memory_ops_log WHERE user_id=$1 AND preset_id=$2`],
    ["tombstones", preserveTombstones
      ? `DELETE FROM chat_context_suppression_tombstones t WHERE t.user_id=$1 AND t.preset_id=$2 AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id=t.message_id AND m.user_id=t.user_id AND m.preset_id=t.preset_id AND t.content_hash='sha256:'||encode(sha256(convert_to(m.content,'UTF8')),'hex'))`
      : `DELETE FROM chat_context_suppression_tombstones WHERE user_id=$1 AND preset_id=$2`],
    ["diagnostics", `DELETE FROM chat_context_quality_diagnostics WHERE user_id=$1 AND preset_id=$2`],
    ["diagnosticProjectionCheckpoints", `DELETE FROM chat_memory_diagnostic_projection_checkpoints WHERE user_id=$1 AND preset_id=$2`],
    ["notifications", `DELETE FROM chat_memory_recovery_notifications WHERE user_id=$1 AND preset_id=$2`],
    ["projections", `DELETE FROM chat_context_projection_checkpoints WHERE user_id=$1 AND preset_id=$2`],
    ["targetStatuses", `DELETE FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2`],
  ]) {
    const result = await db.query(sql, params);
    counts[name] = result.rowCount || 0;
  }
  return counts;
}

async function purgeAuthorityState(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const result = await executor(client).query(`DELETE FROM chat_preset_memory WHERE user_id=$1 AND preset_id=$2`, [scope.userId, scope.presetId]);
  return result.rowCount || 0;
}

async function upsertOperation(userId, presetId, operation, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_privacy_operations (user_id,preset_id,operation_id,operation_mode,source_generation,boundary_message_id,status,last_error_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,preset_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,operation_mode=EXCLUDED.operation_mode,source_generation=EXCLUDED.source_generation,boundary_message_id=EXCLUDED.boundary_message_id,status=EXCLUDED.status,last_error_reason=EXCLUDED.last_error_reason,created_at=NOW(),updated_at=NOW() RETURNING *`, [scope.userId, scope.presetId, operation.operationId, operation.operationMode, operation.sourceGeneration ?? null, operation.boundaryMessageId ?? null, operation.status, operation.lastErrorReason ?? null]);
  return rows[0];
}

async function updateOperation(userId, presetId, changes, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const allowed = { status: "status", lastErrorReason: "last_error_reason" };
  const entries = Object.entries(changes).filter(([key]) => allowed[key]);
  if (!entries.length) return getOperation(userId, presetId, { client });
  const values = entries.map(([, value]) => value ?? null);
  const assignments = entries.map(([key], index) => `${allowed[key]}=$${index + 3}`);
  const { rows } = await executor(client).query(`UPDATE chat_memory_privacy_operations SET ${assignments.join(",")},updated_at=NOW() WHERE user_id=$1 AND preset_id=$2 RETURNING *`, [scope.userId, scope.presetId, ...values]);
  return rows[0] || null;
}

async function getOperation(userId, presetId, { client, forUpdate = false } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_privacy_operations WHERE user_id=$1 AND preset_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [scope.userId, scope.presetId]);
  return rows[0] || null;
}

async function hasIncompleteOperation(userId, presetId, { client } = {}) {
  const operation = await getOperation(userId, presetId, { client });
  return Boolean(operation && operation.status !== "completed");
}

async function listIncompleteOperations({ client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_privacy_operations WHERE status<>'completed' ORDER BY updated_at,created_at`);
  return rows;
}

module.exports = { purgeDerivedHistory, purgeAuthorityState, upsertOperation, updateOperation, getOperation, hasIncompleteOperation, listIncompleteOperations };
