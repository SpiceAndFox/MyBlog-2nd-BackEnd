const crypto = require("node:crypto");
const { fail } = require("./errors");
const { normalizePositiveId } = require("./sendMessage");
const { privacyPayload } = require("./privacy");

function createEditMessageUseCase({
  chatRepository,
  settings,
  memory,
  rag,
  scopeCoordinator,
  logger,
  randomUUID = crypto.randomUUID,
} = {}) {
  for (const method of [
    "getSession",
    "getMessage",
    "deleteMessagesAfter",
    "updateMessageContent",
    "setMessageSourceGeneration",
    "updateSessionSettings",
    "touchSession",
  ]) {
    if (typeof chatRepository?.[method] !== "function") throw new Error(`Chat repository port is missing: ${method}`);
  }
  if (!settings?.resolvePresetForSession || !settings?.isSessionEditableToday) throw new Error("Chat settings service is required");
  if (typeof memory?.privacyHardDelete !== "function") throw new Error("Chat Memory privacy port is required");
  if (typeof rag?.requestDeleteFromMessage !== "function") throw new Error("Chat RAG delete port is required");
  if (!scopeCoordinator?.buildKey || !scopeCoordinator?.cancelByKey) throw new Error("Chat scope coordinator is required");
  if (typeof logger?.error !== "function") throw new Error("Chat logger is required");

  return async function editMessage(input = {}) {
    const userId = input.userId;
    const sessionId = normalizePositiveId(input.sessionId);
    if (!sessionId) fail("Invalid sessionId", { status: 400, code: "CHAT_SESSION_ID_INVALID" });
    const messageId = normalizePositiveId(input.messageId);
    if (!messageId) fail("Invalid messageId", { status: 400, code: "CHAT_MESSAGE_ID_INVALID" });
    const content = String(input.content || "").trim();
    if (!content) fail("Content cannot be empty", { status: 400, code: "CHAT_CONTENT_EMPTY" });

    const regenerate = Boolean(input.regenerate);
    const truncate = regenerate || Boolean(input.truncate);
    const session = await chatRepository.getSession(userId, sessionId);
    if (!session) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
    if (!settings.isSessionEditableToday(session)) {
      fail("Historical sessions are read-only", { status: 403, code: "CHAT_SESSION_READ_ONLY" });
    }
    const message = await chatRepository.getMessage(userId, sessionId, messageId);
    if (!message) fail("Message not found", { status: 404, code: "CHAT_MESSAGE_NOT_FOUND" });
    if (message.role !== "user") fail("Only user messages can be edited", { status: 400, code: "CHAT_MESSAGE_ROLE_INVALID" });

    const incomingSettings = settings.sanitize(input.rawSettings);
    const presetResolution = await settings.resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
    if (presetResolution.error) fail(presetResolution.error, { status: 400, code: "CHAT_PRESET_INVALID" });
    const { presetId, preset } = presetResolution;
    scopeCoordinator.cancelByKey(
      scopeCoordinator.buildKey(userId, presetId),
      Object.assign(new Error("Message edited"), { code: "CHAT_SCOPE_MUTATED" }),
    );

    const mergedSettings = settings.merge(session.settings, incomingSettings);
    mergedSettings.systemPromptPresetId = presetId;
    mergedSettings.systemPrompt = preset?.systemPrompt || "";
    const providerResolution = settings.resolveProviderModel(mergedSettings);
    if (providerResolution.error) {
      fail(providerResolution.error, { status: providerResolution.status, code: "CHAT_PROVIDER_INVALID" });
    }
    const { providerId, modelId, providerDefinition } = providerResolution;
    const validationError = settings.validate(mergedSettings, { providerId, modelId });
    if (validationError) fail(validationError, { status: 400, code: "CHAT_SETTINGS_INVALID" });
    const effectiveSettings = settings.normalize(mergedSettings, { providerId, modelId });
    Object.assign(effectiveSettings, {
      providerId,
      modelId,
      systemPromptPresetId: presetId,
      systemPrompt: preset?.systemPrompt || "",
    });
    if (providerDefinition?.capabilities?.webSearch === false) effectiveSettings.enableWebSearch = false;

    const nextTurnId = randomUUID();
    const regenerationKey = String(message.idempotency_key || "").trim() || `edit:${randomUUID()}`;
    let editedMessage = null;
    const mutation = await memory.privacyHardDelete(userId, presetId, {
      affectedFromMessageId: messageId,
      deleteRawSource: async (client) => {
        if (truncate) await chatRepository.deleteMessagesAfter(userId, sessionId, messageId, { client });
        const updated = await chatRepository.updateMessageContent(userId, sessionId, messageId, content, {
          client,
          turnId: nextTurnId,
          idempotencyKey: regenerationKey,
        });
        if (!updated) throw new Error("Message disappeared during edit");
        editedMessage = updated;
        return updated;
      },
      afterGenerationInitialized: async (client, metadata) => {
        const updated = await chatRepository.setMessageSourceGeneration(
          userId,
          sessionId,
          messageId,
          metadata.sourceGeneration,
          { client },
        );
        if (editedMessage && updated) Object.assign(editedMessage, updated);
      },
    });
    if (!memory.enabled) {
      try {
        rag.requestDeleteFromMessage({ userId, presetId, fromMessageId: messageId });
      } catch (error) {
        logger.error("chat_rag_delete_kick_failed", { error, userId, presetId, fromMessageId: messageId });
      }
    }

    let updatedSession = await chatRepository.updateSessionSettings(
      userId,
      sessionId,
      effectiveSettings,
      presetId,
    ) || session;
    const common = {
      session: updatedSession,
      userMessage: mutation.mutationResult,
      privacy: privacyPayload(mutation),
    };
    if (mutation.status !== "completed") {
      return {
        kind: "privacy_pending",
        ...common,
        regeneration: regenerate ? { idempotencyKey: regenerationKey } : null,
      };
    }
    if (!regenerate) {
      updatedSession = await chatRepository.touchSession(userId, sessionId) || updatedSession;
      return { kind: "updated", session: updatedSession, userMessage: mutation.mutationResult };
    }
    return { kind: "regeneration_required", ...common, regeneration: { idempotencyKey: regenerationKey } };
  };
}

module.exports = { createEditMessageUseCase };
