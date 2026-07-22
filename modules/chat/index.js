const { createChatMemorySourceReader } = require("./memorySourceReader");
const {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
} = require("./memoryAdapters");
const { createChatModule } = require("./application/createChatModule");
const { createChatScopeCoordinator } = require("./application/scopeCoordinator");
const { createChatPersistence } = require("./infrastructure/persistence");
const { createAvatarStorage } = require("./infrastructure/avatarStorage");
const { createProductionModelPolicy, loadProductionModelPolicy, isChatModelAllowed, isMemoryModelAllowed } = require("./modelPolicy");
const { createChatRagModule } = require("./rag");
const { createChatLlmCatalog, createChatLlmRuntime } = require("./infrastructure/llm");

module.exports = Object.freeze({
  createChatModule,
  createChatScopeCoordinator,
  createChatPersistence,
  createAvatarStorage,
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
  createChatMemorySourceReader,
  createProductionModelPolicy,
  loadProductionModelPolicy,
  isChatModelAllowed,
  isMemoryModelAllowed,
  createChatRagModule,
  createChatLlmCatalog,
  createChatLlmRuntime,
});
