const { normalizeScope, executor } = require("./helpers");

async function purgeDerivedHistory(userId, presetId, { client } = {}) {
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
    ["tombstones", `DELETE FROM chat_context_suppression_tombstones WHERE user_id=$1 AND preset_id=$2`],
    ["diagnostics", `DELETE FROM chat_context_quality_diagnostics WHERE user_id=$1 AND preset_id=$2`],
    ["notifications", `DELETE FROM chat_memory_recovery_notifications WHERE user_id=$1 AND preset_id=$2`],
    ["projections", `DELETE FROM chat_context_projection_checkpoints WHERE user_id=$1 AND preset_id=$2`],
    ["targetStatuses", `DELETE FROM chat_memory_target_status WHERE user_id=$1 AND preset_id=$2`],
  ]) {
    const result = await db.query(sql, params);
    counts[name] = result.rowCount || 0;
  }
  return counts;
}

module.exports = { purgeDerivedHistory };
