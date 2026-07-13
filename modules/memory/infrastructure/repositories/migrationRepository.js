const { executor } = require("./helpers");

async function listSourceScopes({ client } = {}) {
  const { rows } = await executor(client).query(`
    SELECT DISTINCT m.user_id, s.preset_id
    FROM chat_messages m
    JOIN chat_sessions s ON s.id=m.session_id
    WHERE s.deleted_at IS NULL AND m.role IN ('user','assistant')
    ORDER BY m.user_id,s.preset_id
  `);
  return rows.map((row) => ({ userId: Number(row.user_id), presetId: row.preset_id }));
}

async function clearLegacyDerivedMemory({ client } = {}) {
  const db = executor(client);
  const checkpoints = await db.query(`DELETE FROM chat_preset_memory_checkpoints`);
  const memory = await db.query(`
    UPDATE chat_preset_memory
    SET rolling_summary='', rolling_summary_updated_at=NULL, summarized_until_message_id=0,
        dirty_since_message_id=NULL, rebuild_required=FALSE, core_memory='{}'::jsonb, updated_at=NOW()
    WHERE rolling_summary<>'' OR rolling_summary_updated_at IS NOT NULL OR summarized_until_message_id<>0
       OR dirty_since_message_id IS NOT NULL OR rebuild_required=TRUE OR core_memory<>'{}'::jsonb
  `);
  return { derivedMemoryRows: memory.rowCount || 0, checkpointRows: checkpoints.rowCount || 0 };
}

async function getLegacyDerivedMemoryResidue({ client } = {}) {
  const db = executor(client);
  const { rows: derivedMemoryRows } = await db.query(`
    SELECT COUNT(*)::BIGINT AS count FROM chat_preset_memory
    WHERE rolling_summary<>'' OR rolling_summary_updated_at IS NOT NULL OR summarized_until_message_id<>0
       OR dirty_since_message_id IS NOT NULL OR rebuild_required=TRUE OR core_memory<>'{}'::jsonb
  `);
  const { rows: checkpointRows } = await db.query(`SELECT COUNT(*)::BIGINT AS count FROM chat_preset_memory_checkpoints`);
  return { derivedMemoryRows: Number(derivedMemoryRows[0].count), checkpointRows: Number(checkpointRows[0].count) };
}

module.exports = { listSourceScopes, clearLegacyDerivedMemory, getLegacyDerivedMemoryResidue };
