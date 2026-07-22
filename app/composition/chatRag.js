const { createChatRagModule } = require("../../modules/chat");

function createChatRagComposition({ config, database, logger, adapters = {} } = {}) {
  if (!config || !database || !logger) throw new Error("Chat RAG composition dependencies are required");
  const embeddings = adapters.embeddings || require("../../services/llm/embeddings");
  const reranker = adapters.reranker || require("../../services/llm/reranker");
  const completions = adapters.completions || require("../../services/llm/chatCompletions");
  return createChatRagModule({
    config: {
      rag: config.chatRagConfig,
      memory: config.memoryV2Config,
    },
    database,
    logger,
    llm: {
      createEmbeddings: adapters.createEmbeddings || embeddings.createEmbeddings,
      rerankDocuments: adapters.rerankDocuments || reranker.rerankDocuments,
      complete: adapters.complete || completions.createChatCompletion,
    },
  });
}

module.exports = { createChatRagComposition };
