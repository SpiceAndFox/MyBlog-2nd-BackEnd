const { executor } = require("./helpers");

async function listSourceScopes({ client } = {}) {
  const { rows } = await executor(client).query(`
    SELECT DISTINCT m.user_id, m.preset_id
    FROM chat_messages m
    JOIN chat_sessions s ON s.id=m.session_id
    WHERE s.user_id=m.user_id AND s.deleted_at IS NULL AND m.role IN ('user','assistant')
    ORDER BY m.user_id,m.preset_id
  `);
  return rows.map((row) => ({ userId: Number(row.user_id), presetId: row.preset_id }));
}

async function hasIncompatibleDerivedData(userId, presetId, schemaVersion, { client } = {}) {
  const normalizedUserId = Number(userId);
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedSchemaVersion = String(schemaVersion || "").trim();
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0 || !normalizedPresetId || !normalizedSchemaVersion) {
    throw new Error("Invalid Memory migration compatibility scope");
  }
  const { rows } = await executor(client).query(`
    SELECT EXISTS (
      SELECT 1 FROM chat_memory_snapshots
      WHERE user_id=$1 AND preset_id=$2 AND schema_version<>$3
      UNION ALL
      SELECT 1 FROM chat_memory_event_groups
      WHERE user_id=$1 AND preset_id=$2 AND schema_version<>$3
      UNION ALL
      SELECT 1 FROM chat_memory_tasks
      WHERE user_id=$1 AND preset_id=$2 AND schema_version<>$3
    ) AS incompatible
  `, [normalizedUserId, normalizedPresetId, normalizedSchemaVersion]);
  return rows[0]?.incompatible === true;
}

module.exports = { listSourceScopes, hasIncompatibleDerivedData };
