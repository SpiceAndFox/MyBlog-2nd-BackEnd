const { createInitialMemoryState, assertMemoryState, SCHEMA_VERSION, TARGET_KEYS } = require("../contracts");
const { normalizeScope, executor, withTransaction } = require("./helpers");
const { isDeepStrictEqual } = require("node:util");

async function getState(userId, presetId, { client, forUpdate = false } = {}) {
  const scope = normalizeScope(userId, presetId);
  const sql = `SELECT memory_state FROM chat_preset_memory WHERE user_id=$1 AND preset_id=$2${forUpdate ? " FOR UPDATE" : ""}`;
  const { rows } = await executor(client).query(sql, [scope.userId, scope.presetId]);
  if (!rows[0] || rows[0].memory_state === null) return null;
  return assertMemoryState(rows[0].memory_state);
}

async function initializeRevisionZero(userId, presetId) {
  const scope = normalizeScope(userId, presetId);
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO chat_preset_memory (user_id,preset_id) VALUES ($1,$2) ON CONFLICT (user_id,preset_id) DO NOTHING`,
      [scope.userId, scope.presetId],
    );
    const { rows } = await client.query(
      `SELECT memory_state FROM chat_preset_memory WHERE user_id=$1 AND preset_id=$2 FOR UPDATE`,
      [scope.userId, scope.presetId],
    );
    if (!rows[0]) throw new Error("chat_preset_memory row could not be initialized");
    let state = rows[0].memory_state;
    if (state === null) {
      state = createInitialMemoryState();
      await client.query(
        `UPDATE chat_preset_memory SET memory_state=$3,updated_at=NOW() WHERE user_id=$1 AND preset_id=$2`,
        [scope.userId, scope.presetId, state],
      );
    } else assertMemoryState(state);
    if (state.meta.revision !== 0 || state.meta.sourceGeneration !== 0)
      throw new Error("initializeRevisionZero cannot initialize an already advanced state");
    await client.query(
      `INSERT INTO chat_memory_snapshots (user_id,preset_id,source_generation,revision,schema_version,state) VALUES ($1,$2,0,0,$3,$4) ON CONFLICT (user_id,preset_id,revision) DO NOTHING`,
      [scope.userId, scope.presetId, SCHEMA_VERSION, state],
    );
    for (const targetKey of TARGET_KEYS) {
      await client.query(
        `INSERT INTO chat_memory_target_status (user_id,preset_id,target_key,source_generation,status,consecutive_errors) VALUES ($1,$2,$3,0,'healthy',0) ON CONFLICT (user_id,preset_id,target_key) DO NOTHING`,
        [scope.userId, scope.presetId, targetKey],
      );
    }
    const { rows: snapshots } = await client.query(
      `SELECT state FROM chat_memory_snapshots WHERE user_id=$1 AND preset_id=$2 AND revision=0`,
      [scope.userId, scope.presetId],
    );
    if (!snapshots[0] || !isDeepStrictEqual(snapshots[0].state, state))
      throw new Error("revision 0 snapshot does not match authority state");
    return state;
  });
}

async function writeState(userId, presetId, state, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  assertMemoryState(state);
  const { rowCount } = await executor(client).query(
    `UPDATE chat_preset_memory SET memory_state=$3,updated_at=NOW() WHERE user_id=$1 AND preset_id=$2`,
    [scope.userId, scope.presetId, state],
  );
  if (rowCount !== 1) throw new Error("Memory authority row not found");
  return state;
}

module.exports = { getState, initializeRevisionZero, writeState };
