const { executor } = require("./helpers");

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

module.exports = { hasIncompatibleDerivedData };
