const { createChatMemorySourceReader } = require("./memorySourceReader");
const {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
} = require("./memoryAdapters");
const { createChatModule } = require("./application/createChatModule");
const { createChatScopeCoordinator } = require("./application/scopeCoordinator");
const { createChatPersistence } = require("./infrastructure/persistence");
const { createAvatarStorage } = require("./infrastructure/avatarStorage");
const { configureProductionModelPolicy, loadProductionModelPolicy, isChatModelAllowed, isMemoryModelAllowed } = require("./modelPolicy");

module.exports = Object.freeze({
  createChatModule,
  createChatScopeCoordinator,
  createChatPersistence,
  createAvatarStorage,
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
  createChatMemorySourceReader,
  configureProductionModelPolicy,
  loadProductionModelPolicy,
  isChatModelAllowed,
  isMemoryModelAllowed,
  get retrieveChatRagContext() { return require("./rag").retrieveChatRagContext; },
  get requestChatTurnIndexing() { return require("./rag").requestChatTurnIndexing; },
  get requestDeleteChunksFromMessageId() { return require("./rag").requestDeleteChunksFromMessageId; },
});
