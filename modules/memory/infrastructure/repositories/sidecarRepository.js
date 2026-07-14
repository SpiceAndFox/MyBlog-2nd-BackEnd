const { normalizeScope, executor } = require("./helpers");

async function upsertProjectionCheckpoint(userId, presetId, checkpoint, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!["rag", "recall"].includes(checkpoint.projectionKey)) throw new Error("Invalid projectionKey");
  if (!["healthy", "degraded", "rebuilding"].includes(checkpoint.status)) throw new Error("Invalid projection status");
  const { rows } = await executor(client).query(`INSERT INTO chat_context_projection_checkpoints (user_id,preset_id,projection_key,processed_generation,processed_boundary_message_id,processed_tombstone_id,status,last_error_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,preset_id,projection_key) DO UPDATE SET processed_generation=EXCLUDED.processed_generation,processed_boundary_message_id=EXCLUDED.processed_boundary_message_id,processed_tombstone_id=EXCLUDED.processed_tombstone_id,status=EXCLUDED.status,last_error_reason=EXCLUDED.last_error_reason,updated_at=NOW() RETURNING *`, [scope.userId,scope.presetId,checkpoint.projectionKey,checkpoint.processedGeneration,checkpoint.processedBoundaryMessageId??null,checkpoint.processedTombstoneId??0,checkpoint.status,checkpoint.lastErrorReason??null]);
  return rows[0];
}
async function insertTombstone(userId, presetId, tombstone, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!["forget", "correction"].includes(tombstone.reason)) throw new Error("Invalid tombstone reason");
  const { rows } = await executor(client).query(`INSERT INTO chat_context_suppression_tombstones (user_id,preset_id,message_id,content_hash,reason,source_item_id,source_section,created_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,preset_id,message_id,content_hash) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING *`, [scope.userId,scope.presetId,tombstone.messageId,tombstone.contentHash,tombstone.reason,tombstone.sourceItemId??null,tombstone.sourceSection??null,tombstone.createdRevision]);
  return rows[0];
}
async function createDiagnostic(userId, presetId, diagnostic, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const fields = ["user_id","preset_id","subject_kind","subject_key","diagnostic_type","source_generation","request_id","target_cursor","processed_boundary_message_id","omitted_upper_message_id","recent_window_start","original_gap_count","original_gap_chars","retained_boundary","retained_count","omitted_count","omitted_chars","truncated","detail"];
  const values = [scope.userId,scope.presetId,diagnostic.subjectKind,diagnostic.subjectKey,diagnostic.diagnosticType,diagnostic.sourceGeneration??null,diagnostic.requestId??null,diagnostic.targetCursor??null,diagnostic.processedBoundaryMessageId??null,diagnostic.omittedUpperMessageId??null,diagnostic.recentWindowStart??null,diagnostic.originalGapCount??null,diagnostic.originalGapChars??null,diagnostic.retainedBoundary??null,diagnostic.retainedCount??null,diagnostic.omittedCount??null,diagnostic.omittedChars??null,Boolean(diagnostic.truncated),diagnostic.detail??{}];
  const { rows } = await executor(client).query(`INSERT INTO chat_context_quality_diagnostics (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, values);
  return rows[0];
}
async function listActiveDiagnostics(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_context_quality_diagnostics WHERE user_id=$1 AND preset_id=$2 AND resolved=FALSE ORDER BY created_at,id`, [scope.userId, scope.presetId]);
  return rows;
}
async function upsertActiveDiagnostic(userId, presetId, diagnostic, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const fields = ["source_generation","request_id","target_cursor","processed_boundary_message_id","omitted_upper_message_id","recent_window_start","original_gap_count","original_gap_chars","retained_boundary","retained_count","omitted_count","omitted_chars","truncated","detail"];
  const values = [diagnostic.sourceGeneration??null,diagnostic.requestId??null,diagnostic.targetCursor??null,diagnostic.processedBoundaryMessageId??null,diagnostic.omittedUpperMessageId??null,diagnostic.recentWindowStart??null,diagnostic.originalGapCount??null,diagnostic.originalGapChars??null,diagnostic.retainedBoundary??null,diagnostic.retainedCount??null,diagnostic.omittedCount??null,diagnostic.omittedChars??null,Boolean(diagnostic.truncated),diagnostic.detail??{}];
  const insertFields = ["user_id","preset_id","subject_kind","subject_key","diagnostic_type",...fields];
  const params = [scope.userId,scope.presetId,diagnostic.subjectKind,diagnostic.subjectKey,diagnostic.diagnosticType,...values];
  const { rows } = await db.query(`INSERT INTO chat_context_quality_diagnostics (${insertFields.join(",")}) VALUES (${insertFields.map((_,index)=>`$${index+1}`).join(",")}) ON CONFLICT (user_id,preset_id,subject_kind,subject_key,diagnostic_type) WHERE resolved=FALSE DO UPDATE SET ${fields.map((field)=>`${field}=EXCLUDED.${field}`).join(",")},updated_at=NOW() WHERE EXCLUDED.diagnostic_type NOT IN ('gap_bridge_omitted','projection_lag') OR COALESCE(EXCLUDED.source_generation,-1)>COALESCE(chat_context_quality_diagnostics.source_generation,-1) OR (EXCLUDED.source_generation IS NOT DISTINCT FROM chat_context_quality_diagnostics.source_generation AND ((EXCLUDED.diagnostic_type='gap_bridge_omitted' AND COALESCE(EXCLUDED.omitted_upper_message_id,-1)>=COALESCE(chat_context_quality_diagnostics.omitted_upper_message_id,-1)) OR (EXCLUDED.diagnostic_type='projection_lag' AND COALESCE(EXCLUDED.recent_window_start,-1)>=COALESCE(chat_context_quality_diagnostics.recent_window_start,-1)))) RETURNING *`, params);
  if (rows[0]) return rows[0];
  const { rows: activeRows } = await db.query(`SELECT * FROM chat_context_quality_diagnostics WHERE user_id=$1 AND preset_id=$2 AND subject_kind=$3 AND subject_key=$4 AND diagnostic_type=$5 AND resolved=FALSE`, params.slice(0, 5));
  return activeRows[0] || null;
}
async function resolveDiagnostic(id, { client } = {}) {
  const { rows } = await executor(client).query(`UPDATE chat_context_quality_diagnostics SET resolved=TRUE,resolved_at=NOW(),updated_at=NOW() WHERE id=$1 AND resolved=FALSE RETURNING *`, [id]);
  return rows[0] || null;
}
async function resolveGapDiagnosticIfProven(id, proof, { client } = {}) {
  const sourceGeneration = Number(proof.sourceGeneration);
  const provenUpperMessageId = Number(proof.provenUpperMessageId);
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) throw new Error("sourceGeneration must be a non-negative safe integer");
  if (!Number.isSafeInteger(provenUpperMessageId) || provenUpperMessageId < 0) throw new Error("provenUpperMessageId must be a non-negative safe integer");
  const { rows } = await executor(client).query(`UPDATE chat_context_quality_diagnostics SET resolved=TRUE,resolved_at=NOW(),updated_at=NOW() WHERE id=$1 AND resolved=FALSE AND diagnostic_type='gap_bridge_omitted' AND source_generation=$2 AND omitted_upper_message_id<=$3 RETURNING *`, [id, sourceGeneration, provenUpperMessageId]);
  return rows[0] || null;
}
async function resolveProjectionDiagnosticIfCovered(id, coverage, { client } = {}) {
  const sourceGeneration = Number(coverage.sourceGeneration);
  const processedBoundaryMessageId = Number(coverage.processedBoundaryMessageId);
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) throw new Error("sourceGeneration must be a non-negative safe integer");
  if (!Number.isSafeInteger(processedBoundaryMessageId) || processedBoundaryMessageId < 0) throw new Error("processedBoundaryMessageId must be a non-negative safe integer");
  const { rows } = await executor(client).query(`UPDATE chat_context_quality_diagnostics SET resolved=TRUE,resolved_at=NOW(),updated_at=NOW() WHERE id=$1 AND resolved=FALSE AND diagnostic_type='projection_lag' AND source_generation=$2 AND GREATEST(0,COALESCE(recent_window_start,1)-1)<=$3 RETURNING *`, [id, sourceGeneration, processedBoundaryMessageId]);
  return rows[0] || null;
}
async function resolveDiagnosticsOutsideGeneration(userId, presetId, sourceGeneration, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rowCount } = await executor(client).query(`UPDATE chat_context_quality_diagnostics SET resolved=TRUE,resolved_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND preset_id=$2 AND resolved=FALSE AND source_generation IS NOT NULL AND source_generation<>$3`, [scope.userId, scope.presetId, sourceGeneration]);
  return rowCount || 0;
}
async function createRecoveryNotification(userId, presetId, notification, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_recovery_notifications (user_id,preset_id,subject_kind,subject_key,notification_type,boundary_message_id,source_generation) VALUES ($1,$2,$3,$4,'recovered',$5,$6) ON CONFLICT (user_id,preset_id,subject_kind,subject_key,notification_type,source_generation,boundary_message_id) DO UPDATE SET subject_key=EXCLUDED.subject_key RETURNING *`, [scope.userId,scope.presetId,notification.subjectKind,notification.subjectKey,notification.boundaryMessageId??0,notification.sourceGeneration]);
  return rows[0];
}
async function listPendingRecoveryNotifications(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_recovery_notifications WHERE user_id=$1 AND preset_id=$2 AND delivered=FALSE ORDER BY created_at,id`, [scope.userId,scope.presetId]);
  return rows;
}
async function markRecoveryNotificationsDelivered(ids, { client } = {}) {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(Number(id)))) throw new Error("notification ids must be integers");
  const { rowCount } = await executor(client).query(`UPDATE chat_memory_recovery_notifications SET delivered=TRUE,delivered_at=NOW() WHERE id=ANY($1::BIGINT[]) AND delivered=FALSE`, [ids]);
  return rowCount;
}
async function listProjectionCheckpoints(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_context_projection_checkpoints WHERE user_id=$1 AND preset_id=$2 ORDER BY projection_key`, [scope.userId,scope.presetId]);
  return rows;
}
async function getProjectionCheckpoint(userId, presetId, projectionKey, { client, forUpdate = false } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!["rag", "recall"].includes(projectionKey)) throw new Error("Invalid projectionKey");
  const { rows } = await executor(client).query(`SELECT * FROM chat_context_projection_checkpoints WHERE user_id=$1 AND preset_id=$2 AND projection_key=$3${forUpdate ? " FOR UPDATE" : ""}`, [scope.userId, scope.presetId, projectionKey]);
  return rows[0] || null;
}
async function listTombstones(userId, presetId, { messageIds, client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const filtered = Array.isArray(messageIds);
  if (filtered && messageIds.some((id) => !Number.isSafeInteger(Number(id)))) throw new Error("messageIds must be integers");
  const { rows } = await executor(client).query(`SELECT * FROM chat_context_suppression_tombstones WHERE user_id=$1 AND preset_id=$2${filtered ? " AND message_id=ANY($3::BIGINT[])" : ""} ORDER BY message_id,id`, filtered ? [scope.userId, scope.presetId, messageIds] : [scope.userId, scope.presetId]);
  return rows;
}
async function markProjectionsRebuilding(userId, presetId, sourceGeneration, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const rows = [];
  for (const projectionKey of ["rag", "recall"]) {
    const result = await db.query(`INSERT INTO chat_context_projection_checkpoints (user_id,preset_id,projection_key,processed_generation,processed_boundary_message_id,status,last_error_reason) VALUES ($1,$2,$3,$4,NULL,'rebuilding',NULL) ON CONFLICT (user_id,preset_id,projection_key) DO UPDATE SET status='rebuilding',last_error_reason=NULL,updated_at=NOW() RETURNING *`, [scope.userId, scope.presetId, projectionKey, sourceGeneration - 1]);
    rows.push(result.rows[0]);
  }
  return rows;
}
module.exports = { upsertProjectionCheckpoint, getProjectionCheckpoint, listProjectionCheckpoints, insertTombstone, listTombstones, markProjectionsRebuilding, createDiagnostic, upsertActiveDiagnostic, listActiveDiagnostics, resolveDiagnostic, resolveGapDiagnosticIfProven, resolveProjectionDiagnosticIfCovered, resolveDiagnosticsOutsideGeneration, createRecoveryNotification, listPendingRecoveryNotifications, markRecoveryNotificationsDelivered };
