const { createRepositoryContext, normalizeScope } = require("./helpers");

function createSourceWriteGuardRepository(dependencies = {}) {
  const { executor } = createRepositoryContext(dependencies);

  async function lockScope(userId, presetId, { client } = {}) {
    if (!client || typeof client.query !== "function") {
      throw new Error("Memory source-write scope lock requires an active transaction client");
    }
    const scope = normalizeScope(userId, presetId);
    await executor(client).query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`memory-source:${scope.userId}:${scope.presetId}`],
    );
    return scope;
  }

  async function lockAndRead(userId, presetId, { client } = {}) {
    const scope = await lockScope(userId, presetId, { client });
    const { rows } = await executor(client).query(`
      SELECT
        COALESCE((
          SELECT (memory_state->'meta'->>'sourceGeneration')::BIGINT
          FROM chat_preset_memory
          WHERE user_id=$1 AND preset_id=$2
        ), 0) AS source_generation,
        EXISTS (
          SELECT 1
          FROM chat_memory_privacy_operations
          WHERE user_id=$1 AND preset_id=$2 AND status<>'completed'
        ) AS privacy_pending
    `, [scope.userId, scope.presetId]);
    return Object.freeze({
      sourceGeneration: Number(rows[0]?.source_generation || 0),
      privacyPending: rows[0]?.privacy_pending === true,
    });
  }

  return Object.freeze({ lockScope, lockAndRead });
}

module.exports = { createSourceWriteGuardRepository };
