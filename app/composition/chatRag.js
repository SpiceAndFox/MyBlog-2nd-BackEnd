const { createChatRagModule } = require("../../modules/chat");

function createChatRagComposition({ config, database, logger, llm, adapters = {} } = {}) {
  if (!config || !database || !logger || typeof llm?.createChatCompletion !== "function") {
    throw new Error("Chat RAG composition dependencies are required");
  }
  return createChatRagModule({
    config: {
      rag: config.chatRagConfig,
      memory: config.memoryV2Config,
    },
    database,
    logger,
    llm: {
      complete: adapters.complete || llm.createChatCompletion,
    },
    infrastructure: {
      embeddingClient: adapters.embeddingClient,
      rerankerClient: adapters.rerankerClient,
      fetchImpl: adapters.fetchImpl,
      openRouterAttribution: llm.openRouterAttribution,
    },
  });
}

module.exports = { createChatRagComposition };
