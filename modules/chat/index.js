const { createChatMemorySourceReader } = require("./memorySourceReader");
const {
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
} = require("./memoryAdapters");
const { createChatModule } = require("./application/createChatModule");

module.exports = Object.freeze({
  createChatModule,
  createChatMemoryAdapters,
  createChatMemoryPrivacyStores,
  createChatMemorySourceReader,
});
