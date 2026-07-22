const { fail } = require("./errors");
const { privacyPayload } = require("./privacy");

function createPresetUseCases({ presetRepository, settings, memory, avatarStorage, scopeCoordinator } = {}) {
  for (const method of [
    "isBuiltinPresetId",
    "listPresets",
    "listTrashedPresets",
    "getPreset",
    "createPreset",
    "updatePreset",
    "updatePresetAvatar",
    "deletePreset",
    "restorePreset",
    "deletePresetPermanently",
  ]) {
    if (typeof presetRepository?.[method] !== "function") throw new Error(`Chat preset repository port is missing: ${method}`);
  }
  if (!settings?.normalizePresetId) throw new Error("Chat settings service is required");
  if (!memory?.rebuildScope || !memory?.privacyHardDelete) throw new Error("Chat Memory port is required");
  if (!avatarStorage?.processUploadedAvatar || !avatarStorage?.deleteAvatarByUrl || !avatarStorage?.deleteFile) {
    throw new Error("Chat avatar storage port is required");
  }
  if (!scopeCoordinator?.buildKey || !scopeCoordinator?.enqueueByKey || !scopeCoordinator?.cancelByKey) {
    throw new Error("Chat scope coordinator is required");
  }

  const normalizePresetId = settings.normalizePresetId;
  function requirePresetId(rawValue) {
    const presetId = normalizePresetId(rawValue);
    if (!presetId) fail("Invalid preset id", { status: 400, code: "CHAT_PRESET_ID_INVALID" });
    return presetId;
  }
  function rejectBuiltin(presetId, message) {
    if (presetRepository.isBuiltinPresetId(presetId)) {
      fail(message, { status: 400, code: "CHAT_BUILTIN_PRESET_READONLY" });
    }
  }
  function cancelScope(userId, presetId, reason) {
    scopeCoordinator.cancelByKey(
      scopeCoordinator.buildKey(userId, presetId),
      Object.assign(new Error(reason), { code: "CHAT_SCOPE_MUTATED" }),
    );
  }

  return Object.freeze({
    list: ({ userId } = {}) => presetRepository.listPresets(userId),
    listTrashed: ({ userId } = {}) => presetRepository.listTrashedPresets(userId),

    async create({ userId, id, name, systemPrompt } = {}) {
      const presetId = requirePresetId(id);
      rejectBuiltin(presetId, "Builtin preset id is reserved");
      const normalizedName = String(name ?? "").trim();
      if (!normalizedName) fail("Preset name cannot be empty", { status: 400, code: "CHAT_PRESET_NAME_EMPTY" });
      try {
        return await presetRepository.createPreset(userId, {
          id: presetId,
          name: normalizedName,
          systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "",
          avatarUrl: null,
        });
      } catch (error) {
        if (error?.code === "23505") fail("Preset id already exists", { status: 409, code: "CHAT_PRESET_EXISTS" });
        throw error;
      }
    },

    async update({ userId, presetId: rawPresetId, changes } = {}) {
      const presetId = requirePresetId(rawPresetId);
      rejectBuiltin(presetId, "Builtin preset cannot be updated");
      if (Object.prototype.hasOwnProperty.call(changes || {}, "id")) {
        fail("Preset id cannot be updated", { status: 400, code: "CHAT_PRESET_ID_IMMUTABLE" });
      }
      let name;
      if (Object.prototype.hasOwnProperty.call(changes || {}, "name")) {
        name = String(changes?.name ?? "").trim();
        if (!name) fail("Preset name cannot be empty", { status: 400, code: "CHAT_PRESET_NAME_EMPTY" });
      }
      const systemPrompt = Object.prototype.hasOwnProperty.call(changes || {}, "systemPrompt")
        ? (typeof changes.systemPrompt === "string" ? changes.systemPrompt : "")
        : undefined;
      try {
        const preset = await presetRepository.updatePreset(userId, presetId, { name, systemPrompt });
        if (!preset) fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
        return preset;
      } catch (error) {
        if (error?.code === "23505") fail("Preset id already exists", { status: 409, code: "CHAT_PRESET_EXISTS" });
        if (["BUILTIN_PRESET_ID", "BUILTIN_PRESET_READONLY"].includes(error?.code)) {
          fail(error.message, { status: 400, code: error.code });
        }
        throw error;
      }
    },

    async rebuildMemory({ userId, presetId: rawPresetId } = {}) {
      const presetId = requirePresetId(rawPresetId);
      const preset = await presetRepository.getPreset(userId, presetId);
      if (!preset) fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
      if (!memory.enabled) fail("Memory Control v2 is disabled", { status: 503, code: "CHAT_MEMORY_DISABLED" });
      return { presetId: preset.id, rebuild: await memory.rebuildScope(userId, preset.id, { reason: "manual_rebuild" }) };
    },

    async trash({ userId, presetId: rawPresetId } = {}) {
      const presetId = requirePresetId(rawPresetId);
      rejectBuiltin(presetId, "Builtin preset cannot be deleted");
      cancelScope(userId, presetId, "Preset deleted");
      const result = await scopeCoordinator.enqueueByKey(
        scopeCoordinator.buildKey(userId, presetId),
        () => presetRepository.deletePreset(userId, presetId),
      );
      if (!result.deleted) fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
    },

    async restore({ userId, presetId: rawPresetId } = {}) {
      const presetId = requirePresetId(rawPresetId);
      rejectBuiltin(presetId, "Builtin preset cannot be restored");
      const preset = await presetRepository.restorePreset(userId, presetId);
      if (!preset) fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
      return preset;
    },

    async removePermanently({ userId, presetId: rawPresetId } = {}) {
      const presetId = requirePresetId(rawPresetId);
      rejectBuiltin(presetId, "Builtin preset cannot be deleted");
      cancelScope(userId, presetId, "Preset permanently deleted");
      const mutation = await memory.privacyHardDelete(userId, presetId, {
        deleteScope: true,
        deleteRawSource: (client) => presetRepository.deletePresetPermanently(userId, presetId, { client }),
        operationPayload: (deletedPreset) => ({
          avatarUrls: deletedPreset.avatarUrl ? [deletedPreset.avatarUrl] : [],
        }),
      });
      if (!mutation.mutationResult) fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
      return { presetId, privacy: privacyPayload(mutation) };
    },

    async uploadAvatar({ userId, presetId: rawPresetId, file } = {}) {
      const presetId = requirePresetId(rawPresetId);
      rejectBuiltin(presetId, "Builtin preset cannot upload avatar");
      if (!file?.path) fail("Missing avatar file", { status: 400, code: "CHAT_AVATAR_MISSING" });
      const existing = await presetRepository.getPreset(userId, presetId);
      if (!existing || existing.isBuiltin) {
        await avatarStorage.deleteFile(file.path);
        fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
      }

      let processed;
      try {
        processed = await avatarStorage.processUploadedAvatar(file);
      } catch {
        await avatarStorage.deleteFile(file.path);
        fail("Avatar processing failed", { status: 400, code: "CHAT_AVATAR_PROCESSING_FAILED" });
      }
      try {
        const preset = await scopeCoordinator.enqueueByKey(
          scopeCoordinator.buildKey(userId, presetId),
          async () => {
            const current = await presetRepository.getPreset(userId, presetId);
            if (!current || current.isBuiltin) return null;
            const previousAvatarUrl = current.avatarUrl || null;
            const updated = await presetRepository.updatePresetAvatar(userId, presetId, processed.avatarUrl);
            if (updated && previousAvatarUrl && previousAvatarUrl !== processed.avatarUrl) {
              try {
                await avatarStorage.deleteAvatarByUrl(previousAvatarUrl);
              } catch (cleanupError) {
                try {
                  await presetRepository.updatePresetAvatar(userId, presetId, previousAvatarUrl);
                  await avatarStorage.deleteFile(processed.path);
                } catch (rollbackError) {
                  rollbackError.keepNewAvatar = true;
                  throw rollbackError;
                }
                throw cleanupError;
              }
            }
            return updated;
          },
        );
        if (!preset) {
          await avatarStorage.deleteFile(processed.path);
          fail("Preset not found", { status: 404, code: "CHAT_PRESET_NOT_FOUND" });
        }
        return preset;
      } catch (error) {
        if (!error?.keepNewAvatar) await avatarStorage.deleteFile(processed.path);
        throw error;
      }
    },
  });
}

module.exports = { createPresetUseCases };
