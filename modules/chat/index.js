const { createChatMemorySourceReader } = require("./memorySourceReader");
const {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
} = require("./memoryAdapters");
const { createChatModule } = require("./application/createChatModule");
const { createChatScopeCoordinator } = require("./application/scopeCoordinator");
const { createChatPersistence } = require("./infrastructure/persistence");
const { createAvatarStorage } = require("./infrastructure/avatarStorage");

module.exports = Object.freeze({
  createChatModule,
  createChatScopeCoordinator,
  createChatPersistence,
  createAvatarStorage,
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
  createChatMemorySourceReader,
});
