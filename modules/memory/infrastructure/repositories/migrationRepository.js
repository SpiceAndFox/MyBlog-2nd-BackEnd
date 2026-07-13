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

module.exports = { listSourceScopes };
