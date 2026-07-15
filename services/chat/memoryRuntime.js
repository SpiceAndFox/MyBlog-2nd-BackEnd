const { memoryV2Config } = require("../../config");
const { logger } = require("../../logger");
const { createDefaultMemoryRuntime, createDefaultProjectionDrain } = require("../../modules/memory");
const { createChatRagProjectionAdapter } = require("./rag/projectionAdapters");
const chatRagRepo = require("./rag/repo");
const chatMessageGistModel = require("../../models/chatMessageGistModel");
const scopeCoordinator = require("./scopeCoordinator");
const { deleteAvatarByUrl, avatarExists, operationAvatarUrls } = require("./avatarStorage");

const projectionDrains = memoryV2Config.enabled ? {
  rag: createDefaultProjectionDrain("rag", createChatRagProjectionAdapter()),
} : {};

module.exports = createDefaultMemoryRuntime({
  config: memoryV2Config,
  projectionDrains,
  privacyStores: [{
    name: "rag",
    purge: ({ userId, presetId, client }) => chatRagRepo.deleteAllChunks(userId, presetId, { client }),
    verifyPurged: async ({ userId, presetId }) => (await chatRagRepo.countStaleChunks(userId, presetId)) === 0,
  }, {
    name: "assistant_gists",
    purge: ({ userId, presetId, client }) => chatMessageGistModel.deleteByScope(userId, presetId, { client }),
    verifyPurged: async ({ userId, presetId }) => (await chatMessageGistModel.countByScope(userId, presetId)) === 0,
  }, {
    name: "avatar_files",
    purge: async ({ operation }) => {
      for (const avatarUrl of operationAvatarUrls(operation)) await deleteAvatarByUrl(avatarUrl);
    },
    verifyPurged: async ({ operation }) => {
      for (const avatarUrl of operationAvatarUrls(operation)) {
        if (await avatarExists(avatarUrl)) return false;
      }
      return true;
    },
  }],
  enqueueByKey: scopeCoordinator.enqueueByKey,
  onBackgroundError: (error) => logger.error("memory_v2_background_failed", { error }),
});
