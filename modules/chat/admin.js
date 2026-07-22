const { createChatGistService } = require("./application/gist");
const { createRecentWindowContextBuilder } = require("./application/context/buildRecentWindowContext");

module.exports = Object.freeze({
  createChatGistService,
  createRecentWindowContextBuilder,
  get indexChatTurn() { return require("./rag/indexer").indexChatTurn; },
  get deleteChunksFromMessageId() { return require("./rag/indexer").deleteChunksFromMessageId; },
  get listExistingTurnKeys() { return require("./rag/repo").listExistingTurnKeys; },
  get createChatRagProjectionAdapter() { return require("./rag/projectionAdapters").createChatRagProjectionAdapter; },
});
