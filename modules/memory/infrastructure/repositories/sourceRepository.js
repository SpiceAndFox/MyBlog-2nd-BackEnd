const crypto = require("node:crypto");
const { normalizeScope, executor } = require("./helpers");

const SOURCE_WHERE = "m.user_id=$1 AND m.preset_id=$2 AND s.deleted_at IS NULL AND m.role IN ('user','assistant')";
function mapRow(row) {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Memory source message id must be a positive safe integer");
  if (!["user", "assistant"].includes(row.role)) throw new Error(`Unsupported Memory source role: ${row.role}`);
  const createdAt = new Date(row.created_at);
  if (Number.isNaN(createdAt.getTime())) throw new Error(`Memory source message ${id} has invalid createdAt`);
  const content = String(row.content ?? "");
  const contentHash = `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
  return { id, role: row.role, createdAt: createdAt.toISOString(), contentKind: "raw", content, contentHash };
}
async function countAfter(userId, presetId, cursor, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT COUNT(*)::BIGINT AS count FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id>$3`, [scope.userId, scope.presetId, cursor]);
  return Number(rows[0].count);
}
async function getObservedWindow(userId, presetId, cursor, { newBatchSize, contextWindow }, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const db = executor(client);
  const { rows: batch } = await db.query(`SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id>$3 ORDER BY m.id ASC LIMIT $4`, [scope.userId, scope.presetId, cursor, newBatchSize]);
  if (!batch.length) return [];
  const overlapLimit = Math.max(0, contextWindow - batch.length);
  let overlap = [];
  if (overlapLimit) {
    const result = await db.query(`SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id<=$3 ORDER BY m.id DESC LIMIT $4`, [scope.userId, scope.presetId, cursor, overlapLimit]);
    overlap = result.rows.reverse();
  }
  return [...overlap, ...batch].map(mapRow);
}
async function getByIds(userId, presetId, ids, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id))) throw new Error("Message ids must be safe integers");
  const { rows } = await executor(client).query(`SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id=ANY($3::BIGINT[]) ORDER BY m.id ASC`, [scope.userId, scope.presetId, ids]);
  return rows.map((row) => ({ ...mapRow(row), userId: scope.userId, presetId: scope.presetId }));
}
async function listUpTo(userId, presetId, upToMessageId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const hasBoundary = upToMessageId !== undefined && upToMessageId !== null;
  const boundary = hasBoundary ? Number(upToMessageId) : null;
  if (hasBoundary && (!Number.isSafeInteger(boundary) || boundary <= 0)) throw new Error("upToMessageId must be a positive safe integer");
  const sql = `SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE}${hasBoundary ? " AND m.id<=$3" : ""} ORDER BY m.id ASC`;
  const { rows } = await executor(client).query(sql, hasBoundary ? [scope.userId, scope.presetId, boundary] : [scope.userId, scope.presetId]);
  return rows.map(mapRow);
}
async function getBoundary(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT MAX(m.id)::BIGINT AS boundary FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE}`, [scope.userId, scope.presetId]);
  return rows[0]?.boundary === null || rows[0]?.boundary === undefined ? 0 : Number(rows[0].boundary);
}
async function hasAnyBetween(userId, presetId, lowerExclusive, upperInclusive, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT EXISTS(SELECT 1 FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id>$3 AND m.id<=$4) AS present`, [scope.userId, scope.presetId, lowerExclusive, upperInclusive]);
  return rows[0]?.present === true;
}
async function getHistoryMetrics(userId, presetId, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  const { rows } = await executor(client).query(`SELECT COUNT(*)::BIGINT AS message_count,COALESCE(SUM(char_length(m.content)),0)::BIGINT AS character_count,COALESCE(MAX(m.id),0)::BIGINT AS boundary_message_id FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE}`, [scope.userId, scope.presetId]);
  const row = rows[0];
  return { messageCount: Number(row.message_count), characterCount: Number(row.character_count), boundaryMessageId: Number(row.boundary_message_id) };
}
async function getHistoryFingerprint(userId, presetId, { client, batchSize = 1000 } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("Memory source fingerprint batchSize must be between 1 and 10000");
  }
  const db = executor(client);
  const hash = crypto.createHash("sha256");
  let cursor = 0;
  while (true) {
    const { rows } = await db.query(`
      SELECT m.id,m.session_id,m.role,m.content,m.created_at,m.turn_id,m.parent_user_message_id
      FROM chat_messages m
      JOIN chat_sessions s ON s.id=m.session_id
      WHERE ${SOURCE_WHERE} AND m.id>$3
      ORDER BY m.id ASC
      LIMIT $4
    `, [scope.userId, scope.presetId, cursor, batchSize]);
    if (!rows.length) break;
    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= cursor) throw new Error("Memory source fingerprint rows are not strictly ordered safe ids");
      const createdAt = new Date(row.created_at);
      if (Number.isNaN(createdAt.getTime())) throw new Error(`Memory source message ${id} has invalid createdAt`);
      hash.update(JSON.stringify([
        String(row.id), String(row.session_id), String(row.role), String(row.content ?? ""), createdAt.toISOString(),
        row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
        row.parent_user_message_id === null || row.parent_user_message_id === undefined
          ? null
          : String(row.parent_user_message_id),
      ])).update("\n");
      cursor = id;
    }
    if (rows.length < batchSize) break;
  }
  return `sha256:${hash.digest("hex")}`;
}
async function getForceDrainWindow(userId, presetId, cursor, boundary, { newBatchSize, contextWindow }, { client } = {}) {
  const scope = normalizeScope(userId, presetId);
  if (![cursor, boundary, newBatchSize, contextWindow].every(Number.isSafeInteger) || cursor < 0 || boundary < cursor || newBatchSize < 1 || contextWindow < newBatchSize) throw new Error("Invalid force-drain window parameters");
  const db = executor(client);
  const { rows: batch } = await db.query(`SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id>$3 AND m.id<=$4 ORDER BY m.id ASC LIMIT $5`, [scope.userId, scope.presetId, cursor, boundary, newBatchSize]);
  if (!batch.length) return [];
  const overlapLimit = Math.max(0, contextWindow - batch.length);
  let overlap = [];
  if (overlapLimit) {
    const result = await db.query(`SELECT m.id,m.role,m.content,m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE ${SOURCE_WHERE} AND m.id<=$3 ORDER BY m.id DESC LIMIT $4`, [scope.userId, scope.presetId, cursor, overlapLimit]);
    overlap = result.rows.reverse();
  }
  return [...overlap, ...batch].map(mapRow);
}
module.exports = { countAfter, getObservedWindow, getByIds, listUpTo, getBoundary, hasAnyBetween, getHistoryMetrics, getHistoryFingerprint, getForceDrainWindow };
