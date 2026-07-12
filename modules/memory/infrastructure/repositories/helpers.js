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
  let committing = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    const connectionLost = committing && (
      error?.connectionLost === true ||
      ["ECONNRESET", "ECONNREFUSED", "EPIPE", "57P01", "57P02", "57P03", "08000", "08003", "08006", "08007", "08P01"].includes(error?.code)
    );
    if (connectionLost) error.commitOutcomeUnknown = true;
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
