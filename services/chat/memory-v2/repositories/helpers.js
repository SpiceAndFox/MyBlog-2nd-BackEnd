const db = require("../../../../db");

function normalizeScope(userId, presetId) {
  const normalizedUserId = Number(userId);
  const normalizedPresetId = String(presetId || "").trim();
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) throw new Error("userId must be a positive safe integer");
  if (!normalizedPresetId) throw new Error("presetId is required");
  return { userId: normalizedUserId, presetId: normalizedPresetId };
}

function executor(client) { return client && typeof client.query === "function" ? client : db; }

async function withTransaction(work) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
}

function mapNumbers(row, keys) {
  if (!row) return null;
  const result = { ...row };
  keys.forEach((key) => { if (result[key] !== null && result[key] !== undefined) result[key] = Number(result[key]); });
  return result;
}

module.exports = { normalizeScope, executor, withTransaction, mapNumbers };
