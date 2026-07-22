function normalizeScope(userId, presetId) {
  const normalizedUserId = Number(userId);
  const normalizedPresetId = String(presetId || "").trim();
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) throw new Error("userId must be a positive safe integer");
  if (!normalizedPresetId) throw new Error("presetId is required");
  return { userId: normalizedUserId, presetId: normalizedPresetId };
}

function createRepositoryContext({ database, transactionExecutor } = {}) {
  if (typeof database?.query !== "function") throw new Error("Memory repositories require an injected database");
  if (typeof transactionExecutor?.run !== "function") {
    throw new Error("Memory repositories require an injected transaction executor");
  }
  return Object.freeze({
    executor(client) {
      return client && typeof client.query === "function" ? client : database;
    },
    withTransaction: transactionExecutor.run,
  });
}

function mapNumbers(row, keys) {
  if (!row) return null;
  const result = { ...row };
  keys.forEach((key) => { if (result[key] !== null && result[key] !== undefined) result[key] = Number(result[key]); });
  return result;
}

module.exports = { createRepositoryContext, normalizeScope, mapNumbers };
