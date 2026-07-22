const { fail } = require("./errors");

function privacyPayload(mutation) {
  return {
    operationId: mutation.operationId,
    status: mutation.status,
    rawMutationCommitted: Boolean(mutation.rawMutationCommitted),
  };
}

function createGetPrivacyOperationUseCase({ memory } = {}) {
  if (typeof memory?.getPrivacyOperation !== "function") throw new Error("Chat Memory privacy port is required");
  return async function getPrivacyOperation({ userId, operationId } = {}) {
    const operation = await memory.getPrivacyOperation(userId, operationId);
    if (!operation) fail("Privacy operation not found", { status: 404, code: "CHAT_PRIVACY_OPERATION_NOT_FOUND" });
    return {
      operationId: operation.operation_id ?? operation.operationId,
      presetId: operation.preset_id ?? operation.presetId,
      mode: operation.operation_mode ?? operation.operationMode,
      status: operation.status,
      rawMutationCommitted: true,
      lastErrorReason: operation.last_error_reason ?? operation.lastErrorReason ?? null,
      createdAt: operation.created_at ?? operation.createdAt,
      updatedAt: operation.updated_at ?? operation.updatedAt,
    };
  };
}

module.exports = { createGetPrivacyOperationUseCase, privacyPayload };
