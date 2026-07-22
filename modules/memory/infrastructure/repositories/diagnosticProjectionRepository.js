const { createRepositoryContext, normalizeScope } = require("./helpers");

function createDiagnosticProjectionRepository(dependencies = {}) {
const { executor } = createRepositoryContext(dependencies);

async function lockCheckpoint(userId, presetId, projectionKey, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  await db.query(`INSERT INTO chat_memory_diagnostic_projection_checkpoints (user_id,preset_id,projection_key) VALUES ($1,$2,$3) ON CONFLICT (user_id,preset_id,projection_key) DO NOTHING`, [scope.userId, scope.presetId, projectionKey]);
  const { rows } = await db.query(`SELECT * FROM chat_memory_diagnostic_projection_checkpoints WHERE user_id=$1 AND preset_id=$2 AND projection_key=$3 FOR UPDATE`, [scope.userId, scope.presetId, projectionKey]);
  return rows[0];
}

async function listCommittedEventsAfter(userId, presetId, processedEventId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const boundary = Number(processedEventId);
  if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("processedEventId must be a non-negative safe integer");
  const { rows } = await executor(client).query(`SELECT e.*,g.group_kind,g.source_generation AS group_source_generation,g.result_revision,g.cursor_after FROM chat_memory_events e JOIN chat_memory_event_groups g ON g.event_group_id=e.event_group_id WHERE e.user_id=$1 AND e.preset_id=$2 AND e.id>$3 AND g.result_revision IS NOT NULL ORDER BY e.id`, [scope.userId, scope.presetId, boundary]);
  return rows;
}

async function advanceCheckpoint(userId, presetId, projectionKey, processedEventId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const boundary = Number(processedEventId);
  if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("processedEventId must be a non-negative safe integer");
  const { rows } = await executor(client).query(`UPDATE chat_memory_diagnostic_projection_checkpoints SET processed_event_id=GREATEST(processed_event_id,$4),last_error_reason=NULL,updated_at=NOW() WHERE user_id=$1 AND preset_id=$2 AND projection_key=$3 RETURNING *`, [scope.userId, scope.presetId, projectionKey, boundary]);
  return rows[0] || null;
}

async function recordProjectionError(userId, presetId, projectionKey, reason, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const normalizedReason = String(reason || "diagnostic_projection_failed").slice(0, 500);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_diagnostic_projection_checkpoints (user_id,preset_id,projection_key,last_error_reason) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,preset_id,projection_key) DO UPDATE SET last_error_reason=EXCLUDED.last_error_reason,updated_at=NOW() RETURNING *`, [scope.userId, scope.presetId, projectionKey, normalizedReason]);
  return rows[0];
}

return Object.freeze({ lockCheckpoint, listCommittedEventsAfter, advanceCheckpoint, recordProjectionError });
}

module.exports = { createDiagnosticProjectionRepository };
