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
module.exports = { insertSnapshot, getSnapshot, insertEventGroup, getEventGroup, insertEvents };
