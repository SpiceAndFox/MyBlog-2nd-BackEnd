const { createChatMemorySourceReader } = require("./memorySourceReader");

function createChatMemoryPrivacyStores({ database } = {}) {
  const chatRagRepository = require("../../services/chat/rag/repo");
  const { createChatGistRepository } = require("./infrastructure/repositories/gistRepository");
  const { createAvatarStorage, operationAvatarUrls } = require("./infrastructure/avatarStorage");
  const chatMessageGistModel = createChatGistRepository({ database });
  const { deleteAvatarByUrl, avatarExists } = createAvatarStorage();
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

function createChatMemoryAdapters({ database, scopeCoordinator } = {}) {
  const { createChatRagProjectionAdapter } = require("../../services/chat/rag/projectionAdapters");
  if (typeof scopeCoordinator?.enqueueByKey !== "function") throw new Error("Chat scope coordinator is required");
  return Object.freeze({
    sourceReader: createChatMemorySourceReader({ database }),
    ragProjectionAdapter: createChatRagProjectionAdapter(),
    privacyStores: createChatMemoryPrivacyStores({ database }),
    enqueueByKey: scopeCoordinator.enqueueByKey,
  });
}

module.exports = {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
};
