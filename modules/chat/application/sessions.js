const { fail } = require("./errors");
const { normalizePositiveId } = require("./sendMessage");
const { privacyPayload } = require("./privacy");

function createSessionUseCases({ chatRepository, settings, memory, scopeCoordinator } = {}) {
  for (const method of [
    "listSessions",
    "listTrashedSessions",
    "createSession",
    "getSession",
    "trashSession",
    "getTrashedSession",
    "restoreSession",
    "deleteSessionPermanently",
    "listMessages",
  ]) {
    if (typeof chatRepository?.[method] !== "function") throw new Error(`Chat repository port is missing: ${method}`);
  }
  if (!settings?.resolvePresetForSession || !settings?.resolveProviderModel) throw new Error("Chat settings service is required");
  if (!memory?.mutateSourceAndRebuild || !memory?.privacyHardDelete) throw new Error("Chat Memory port is required");
  if (!scopeCoordinator?.buildKey || !scopeCoordinator?.cancelByKey) throw new Error("Chat scope coordinator is required");

  function requireSessionId(rawValue) {
    const sessionId = normalizePositiveId(rawValue);
    if (!sessionId) fail("Invalid sessionId", { status: 400, code: "CHAT_SESSION_ID_INVALID" });
    return sessionId;
  }
  function presetIdOf(session) {
    return String(session?.preset_id || session?.presetId || "").trim();
  }
  function cancelScope(userId, presetId, reason) {
    scopeCoordinator.cancelByKey(
      scopeCoordinator.buildKey(userId, presetId),
      Object.assign(new Error(reason), { code: "CHAT_SCOPE_MUTATED" }),
    );
  }

  return Object.freeze({
    list: ({ userId } = {}) => chatRepository.listSessions(userId),
    listTrashed: ({ userId } = {}) => chatRepository.listTrashedSessions(userId),

    async create({ userId, title, rawSettings, explicitPresetId } = {}) {
      const settingsInput = settings.sanitize(rawSettings);
      const presetResolution = await settings.resolvePresetForSession({
        userId,
        incomingSettings: settingsInput,
        explicitPresetId,
      });
      if (presetResolution.error) fail(presetResolution.error, { status: 400, code: "CHAT_PRESET_INVALID" });
      const { presetId, preset } = presetResolution;
      let effectiveSettings = {
        ...settingsInput,
        systemPromptPresetId: presetId,
        systemPrompt: preset?.systemPrompt || "",
      };
      const providerResolution = settings.resolveProviderModel(effectiveSettings);
      if (providerResolution.error) {
        fail(providerResolution.error, { status: providerResolution.status, code: "CHAT_PROVIDER_INVALID" });
      }
      const { providerId, modelId, providerDefinition } = providerResolution;
      const validationError = settings.validate(effectiveSettings, { providerId, modelId });
      if (validationError) fail(validationError, { status: 400, code: "CHAT_SETTINGS_INVALID" });
      effectiveSettings = settings.normalize(effectiveSettings, { providerId, modelId });
      Object.assign(effectiveSettings, {
        providerId,
        modelId,
        systemPromptPresetId: presetId,
        systemPrompt: preset?.systemPrompt || "",
      });
      if (providerDefinition?.capabilities?.webSearch === false) effectiveSettings.enableWebSearch = false;
      return chatRepository.createSession(userId, { title, settings: effectiveSettings, presetId });
    },

    async trash({ userId, sessionId: rawSessionId } = {}) {
      const sessionId = requireSessionId(rawSessionId);
      const existing = await chatRepository.getSession(userId, sessionId);
      if (!existing) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      const presetId = presetIdOf(existing);
      cancelScope(userId, presetId, "Session trashed");
      const mutation = await memory.mutateSourceAndRebuild(userId, presetId, {
        reason: "session_trashed",
        mutateSource: (client) => chatRepository.trashSession(userId, sessionId, { client }),
      });
      if (!mutation.mutationResult) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
    },

    async restore({ userId, sessionId: rawSessionId } = {}) {
      const sessionId = requireSessionId(rawSessionId);
      const existing = await chatRepository.getTrashedSession(userId, sessionId);
      if (!existing) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      const presetId = presetIdOf(existing);
      cancelScope(userId, presetId, "Session restored");
      const mutation = await memory.mutateSourceAndRebuild(userId, presetId, {
        reason: "session_restored",
        mutateSource: (client) => chatRepository.restoreSession(userId, sessionId, { client }),
      });
      if (!mutation.mutationResult) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      return mutation.mutationResult;
    },

    async removePermanently({ userId, sessionId: rawSessionId } = {}) {
      const sessionId = requireSessionId(rawSessionId);
      const existing = await chatRepository.getTrashedSession(userId, sessionId);
      if (!existing) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      const presetId = presetIdOf(existing);
      cancelScope(userId, presetId, "Session permanently deleted");
      const mutation = await memory.privacyHardDelete(userId, presetId, {
        deleteRawSource: (client) => chatRepository.deleteSessionPermanently(userId, sessionId, { client }),
      });
      if (!mutation.mutationResult) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      return { sessionId, privacy: privacyPayload(mutation) };
    },

    async listMessages({ userId, sessionId: rawSessionId } = {}) {
      const sessionId = requireSessionId(rawSessionId);
      const messages = await chatRepository.listMessages(userId, sessionId);
      if (messages === null) fail("Session not found", { status: 404, code: "CHAT_SESSION_NOT_FOUND" });
      return messages;
    },
  });
}

module.exports = { createSessionUseCases };
