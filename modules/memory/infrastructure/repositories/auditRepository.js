const { normalizeScope, executor } = require("./helpers");

async function insertSnapshot(userId, presetId, { sourceGeneration, revision, schemaVersion, state }, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_snapshots (user_id,preset_id,source_generation,revision,schema_version,state) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [scope.userId, scope.presetId, sourceGeneration, revision, schemaVersion, state]);
  return rows[0];
}
async function getSnapshot(userId, presetId, revision, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 AND revision=$3`, [scope.userId, scope.presetId, revision]);
  return rows[0] || null;
}
async function insertEventGroup(group, { client } = {}) {
  const fields = ["event_group_id","user_id","preset_id","task_id","target_key","source_generation","schema_version","base_revision","result_revision","cursor_before","cursor_after","group_kind"];
  const values = fields.map((field) => group[field] ?? null);
  const { rows } = await executor(client).query(`INSERT INTO chat_memory_event_groups (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, values);
  return rows[0];
}
async function getEventGroup(eventGroupId, { client } = {}) {
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_event_groups WHERE event_group_id=$1`, [eventGroupId]);
  return rows[0] || null;
}
async function insertEvents(events, { client } = {}) {
  const result = [];
  for (const event of events) {
    const fields = ["event_group_id","event_index","user_id","preset_id","task_id","tick_id","target_key","section","event_kind","decision","patch_id","op","item_id","result_item_id","merged_from_item_ids","evidence_kind","reject_reason","maintenance_task_id","patch_summary","normalized_operation","cleanup_type"];
    const values = fields.map((field) => event[field] ?? null);
    const { rows } = await executor(client).query(`INSERT INTO chat_memory_events (${fields.join(",")}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, values);
    result.push(rows[0]);
  }
  return result;
}
async function listSnapshots(userId, presetId, sourceGeneration, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 AND source_generation=$3 ORDER BY revision`, [scope.userId, scope.presetId, sourceGeneration]);
  return rows;
}
async function listSnapshotsForRecovery(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 ORDER BY revision DESC`, [scope.userId, scope.presetId]);
  return rows;
}
async function getRecoveryHead(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT GREATEST(COALESCE((SELECT MAX(revision) FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2),0),COALESCE((SELECT MAX(result_revision) FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2),0)) AS revision,GREATEST(COALESCE((SELECT MAX(source_generation) FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2),0),COALESCE((SELECT MAX(source_generation) FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2),0)) AS source_generation`, [scope.userId, scope.presetId]);
  return { revision: Number(rows[0]?.revision ?? 0), sourceGeneration: Number(rows[0]?.source_generation ?? 0) };
}
async function listRevisionGroups(userId, presetId, sourceGeneration, afterRevision = -1, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT * FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2 AND source_generation=$3 AND result_revision>$4 ORDER BY result_revision`, [scope.userId, scope.presetId, sourceGeneration, afterRevision]);
  return rows;
}
async function promoteAnchor(userId, presetId, sourceGeneration, revision, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const snapshot = await getSnapshot(userId, presetId, revision, { client: db });
  if (!snapshot || Number(snapshot.source_generation) !== sourceGeneration) throw new Error("Retention anchor snapshot is missing or belongs to another generation");
  const groups = await listRevisionGroups(userId, presetId, sourceGeneration, revision, { client: db });
  let expected = revision + 1;
  for (const group of groups) {
    if (Number(group.result_revision) !== expected) throw new Error("Retained Memory event groups are not revision-contiguous");
    expected += 1;
  }
  await db.query(`DELETE FROM chat_memory_events WHERE event_group_id IN (SELECT event_group_id FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2 AND source_generation=$3 AND result_revision<=$4)`, [scope.userId, scope.presetId, sourceGeneration, revision]);
  const groupsDeleted = await db.query(`DELETE FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2 AND source_generation=$3 AND result_revision<=$4`, [scope.userId, scope.presetId, sourceGeneration, revision]);
  const snapshotsDeleted = await db.query(`DELETE FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 AND source_generation=$3 AND revision<$4`, [scope.userId, scope.presetId, sourceGeneration, revision]);
  return { snapshot, groupsDeleted: groupsDeleted.rowCount || 0, snapshotsDeleted: snapshotsDeleted.rowCount || 0 };
}
async function deleteExpiredAudit(userId, presetId, { currentGeneration, eventBefore, snapshotBefore, allowOldGenerations }, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const params = [scope.userId, scope.presetId, currentGeneration, eventBefore];
  const eligible = allowOldGenerations
    ? `(result_revision IS NULL OR source_generation<$3)`
    : `result_revision IS NULL`;
  const events = await db.query(`DELETE FROM chat_memory_events WHERE event_group_id IN (SELECT event_group_id FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2 AND created_at<$4 AND ${eligible})`, params);
  const groups = await db.query(`DELETE FROM chat_memory_event_groups WHERE user_id=$1 AND preset_id=$2 AND created_at<$4 AND ${eligible}`, params);
  let snapshots = { rowCount: 0 };
  if (allowOldGenerations) snapshots = await db.query(`DELETE FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 AND source_generation<$3 AND created_at<$4`, [scope.userId, scope.presetId, currentGeneration, snapshotBefore]);
  return { expiredEvents: events.rowCount || 0, expiredGroups: groups.rowCount || 0, expiredSnapshots: snapshots.rowCount || 0 };
}
module.exports = { insertSnapshot, getSnapshot, insertEventGroup, getEventGroup, insertEvents, listSnapshots, listSnapshotsForRecovery, getRecoveryHead, listRevisionGroups, promoteAnchor, deleteExpiredAudit };
