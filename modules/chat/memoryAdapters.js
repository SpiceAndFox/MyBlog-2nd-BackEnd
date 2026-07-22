const { createChatMemorySourceReader } = require("./memorySourceReader");

function createChatMemoryPrivacyStores() {
  const chatRagRepository = require("../../services/chat/rag/repo");
  const chatMessageGistModel = require("../../models/chatMessageGistModel");
  const {
    deleteAvatarByUrl,
    avatarExists,
    operationAvatarUrls,
  } = require("../../services/chat/avatarStorage");
  return Object.freeze([{
    name: "rag",
    purge: ({ userId, presetId, client }) => chatRagRepository.deleteAllChunks(userId, presetId, { client }),
    verifyPurged: async ({ userId, presetId }) => (await chatRagRepository.countStaleChunks(userId, presetId)) === 0,
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
  }]);
}

function createChatMemoryAdapters({ database } = {}) {
  const { createChatRagProjectionAdapter } = require("../../services/chat/rag/projectionAdapters");
  const scopeCoordinator = require("../../services/chat/scopeCoordinator");
  return Object.freeze({
    sourceReader: createChatMemorySourceReader({ database }),
    ragProjectionAdapter: createChatRagProjectionAdapter(),
    privacyStores: createChatMemoryPrivacyStores(),
    enqueueByKey: scopeCoordinator.enqueueByKey,
  });
}

module.exports = {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
};
