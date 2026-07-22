const test = require("node:test");
const assert = require("node:assert/strict");

const { createPresetUseCases } = require("../../modules/chat/application/presets");
const { createSessionUseCases } = require("../../modules/chat/application/sessions");

function coordinator(events) {
  return {
    buildKey: (userId, presetId) => `${userId}:${presetId}`,
    cancelByKey(key, reason) { events.push(["cancel", key, reason.code]); },
    enqueueByKey(_key, task) { return task({ signal: new AbortController().signal }); },
  };
}

test("permanent Session deletion keeps raw deletion inside the Memory-owned transaction", async () => {
  const events = [];
  const transactionClient = { transaction: true };
  const chatRepository = {
    async getTrashedSession() { return { id: 17, preset_id: "companion" }; },
    async deleteSessionPermanently(userId, sessionId, { client }) {
      events.push(["raw-delete", userId, sessionId, client]);
      return { id: sessionId };
    },
  };
  for (const method of ["listSessions", "listTrashedSessions", "createSession", "getSession", "trashSession", "restoreSession", "listMessages"]) {
    chatRepository[method] = async () => null;
  }
  const memory = {
    async mutateSourceAndRebuild() {},
    async privacyHardDelete(userId, presetId, options) {
      events.push(["privacy", userId, presetId]);
      return {
        operationId: "privacy-session",
        status: "purging",
        rawMutationCommitted: true,
        mutationResult: await options.deleteRawSource(transactionClient),
      };
    },
  };
  const sessions = createSessionUseCases({
    chatRepository,
    settings: { resolvePresetForSession() {}, resolveProviderModel() {} },
    memory,
    scopeCoordinator: coordinator(events),
  });

  const result = await sessions.removePermanently({ userId: 9, sessionId: "17" });

  assert.deepEqual(events, [
    ["cancel", "9:companion", "CHAT_SCOPE_MUTATED"],
    ["privacy", 9, "companion"],
    ["raw-delete", 9, 17, transactionClient],
  ]);
  assert.deepEqual(result, {
    sessionId: 17,
    privacy: { operationId: "privacy-session", status: "purging", rawMutationCommitted: true },
  });
});

test("permanent Preset deletion durably carries its avatar target into the privacy operation", async () => {
  const events = [];
  let operationPayload;
  const presetRepository = {
    isBuiltinPresetId: () => false,
    async deletePresetPermanently(_userId, _presetId, { client }) {
      assert.deepEqual(client, { transaction: true });
      return { deleted: true, avatarUrl: "/uploads/assistant_avatars/old.webp" };
    },
  };
  for (const method of [
    "listPresets", "listTrashedPresets", "getPreset", "createPreset", "updatePreset",
    "updatePresetAvatar", "deletePreset", "restorePreset",
  ]) presetRepository[method] = async () => null;
  const memory = {
    enabled: true,
    async rebuildScope() {},
    async privacyHardDelete(_userId, _presetId, options) {
      const mutationResult = await options.deleteRawSource({ transaction: true });
      operationPayload = options.operationPayload(mutationResult);
      return { operationId: "privacy-preset", status: "purging", rawMutationCommitted: true, mutationResult };
    },
  };
  const presets = createPresetUseCases({
    presetRepository,
    settings: { normalizePresetId: (value) => String(value || "").trim() || null },
    memory,
    avatarStorage: { processUploadedAvatar() {}, deleteAvatarByUrl() {}, deleteFile() {} },
    scopeCoordinator: coordinator(events),
  });

  const result = await presets.removePermanently({ userId: 4, presetId: "companion" });

  assert.deepEqual(operationPayload, { avatarUrls: ["/uploads/assistant_avatars/old.webp"] });
  assert.equal(result.privacy.operationId, "privacy-preset");
  assert.deepEqual(events, [["cancel", "4:companion", "CHAT_SCOPE_MUTATED"]]);
});

test("Session creation resolves one preset and persists normalized provider settings", async () => {
  let inserted;
  const chatRepository = {
    async createSession(userId, value) { inserted = { userId, ...value }; return { id: 3, ...value }; },
  };
  for (const method of [
    "listSessions", "listTrashedSessions", "getSession", "trashSession", "getTrashedSession",
    "restoreSession", "deleteSessionPermanently", "listMessages",
  ]) chatRepository[method] = async () => null;
  const settings = {
    sanitize: (value) => ({ ...value }),
    async resolvePresetForSession() { return { presetId: "companion", preset: { systemPrompt: "Stay kind." } }; },
    resolveProviderModel() {
      return { providerId: "deepseek", modelId: "chat-model", providerDefinition: { capabilities: { webSearch: false } } };
    },
    validate: () => null,
    normalize: (value) => ({ ...value, temperature: 0.4 }),
  };
  const sessions = createSessionUseCases({
    chatRepository,
    settings,
    memory: { mutateSourceAndRebuild() {}, privacyHardDelete() {} },
    scopeCoordinator: coordinator([]),
  });

  await sessions.create({ userId: 2, title: "today", rawSettings: { enableWebSearch: true } });

  assert.equal(inserted.presetId, "companion");
  assert.deepEqual(inserted.settings, {
    enableWebSearch: false,
    systemPromptPresetId: "companion",
    systemPrompt: "Stay kind.",
    temperature: 0.4,
    providerId: "deepseek",
    modelId: "chat-model",
  });
});
