const { createChatMemorySourceReader } = require("./memorySourceReader");

function createChatMemoryPrivacyStores({ database, ragPrivacyStore } = {}) {
  const { createChatGistRepository } = require("./infrastructure/repositories/gistRepository");
  const { createAvatarStorage, operationAvatarUrls } = require("./infrastructure/avatarStorage");
  const chatMessageGistModel = createChatGistRepository({ database });
  const { deleteAvatarByUrl, avatarExists } = createAvatarStorage();
  if (typeof ragPrivacyStore?.purge !== "function" || typeof ragPrivacyStore?.verifyPurged !== "function") {
    throw new Error("Chat RAG privacy store is required");
  }
  return Object.freeze([ragPrivacyStore, {
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

function createChatMemoryAdapters({ database, scopeCoordinator, ragProjectionAdapter, ragPrivacyStore } = {}) {
  if (typeof scopeCoordinator?.enqueueByKey !== "function") throw new Error("Chat scope coordinator is required");
  if (!ragProjectionAdapter?.rebuild || !ragProjectionAdapter?.commit) throw new Error("Chat RAG projection adapter is required");
  return Object.freeze({
    sourceReader: createChatMemorySourceReader({ database }),
    ragProjectionAdapter,
    privacyStores: createChatMemoryPrivacyStores({ database, ragPrivacyStore }),
    enqueueByKey: scopeCoordinator.enqueueByKey,
  });
}

module.exports = {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
};
