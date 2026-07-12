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
module.exports = { countAfter, getObservedWindow, getByIds };
