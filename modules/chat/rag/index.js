const { createChatRagChunker } = require("./chunker");
const { createChatRagRepository } = require("./repo");
const { createChatRagSceneRecall } = require("./sceneRecall");
const { createChatRagRetriever } = require("./retriever");
const { createChatRagIndexer } = require("./indexer");
const { createChatRagProjectionAdapter } = require("./projectionAdapters");
const { createEmbeddingClient } = require("./infrastructure/embeddings");
const { createProviderHealth } = require("../../../shared/observability/providerHealth");
const { createRerankerClient } = require("./infrastructure/reranker");

function createChatRagModule({ config, database, logger, llm, infrastructure = {} } = {}) {
  if (!config?.rag || !config?.memory) throw new Error("Chat RAG module config is required");
  if (typeof database?.query !== "function") throw new Error("Chat RAG database is required");
  if (!logger || typeof logger !== "object") throw new Error("Chat RAG logger is required");
  if (typeof llm?.complete !== "function") throw new Error("Chat RAG completion port is required");

  const embeddingClient = infrastructure.embeddingClient || createEmbeddingClient({
    config: config.rag,
    fetchImpl: infrastructure.fetchImpl,
    openRouterAttribution: infrastructure.openRouterAttribution,
  });
  const embeddingHealth = createProviderHealth({ name: "embedding" });
  const rerankerClient = infrastructure.rerankerClient || createRerankerClient({
    config: config.rag,
    fetchImpl: infrastructure.fetchImpl,
  });
  async function createEmbeddings(options) {
    try {
      const result = await embeddingClient.createEmbeddings(options);
      embeddingHealth.recordSuccess();
      return result;
    } catch (error) {
      if (!options?.signal?.aborted) embeddingHealth.recordFailure(error);
      error.providerSuccessCount = embeddingHealth.snapshot().successCount;
      throw error;
    }
  }
  const { rerankDocuments } = rerankerClient;

  const chunker = createChatRagChunker({ config: config.rag });
  const repository = createChatRagRepository({ database, config: config.rag });
  const sceneRecall = createChatRagSceneRecall({
    config: config.rag,
    logger,
    complete: llm.complete,
    repository,
  });
  const retriever = createChatRagRetriever({
    config: config.rag,
    logger,
    createEmbeddings,
    rerankDocuments,
    repository,
    generateSceneRecallForSource: sceneRecall.generateSceneRecallForSource,
  });
  const indexer = createChatRagIndexer({
    config: config.rag,
    memoryConfig: config.memory,
    logger,
    createEmbeddings,
    chunker,
    repository,
  });
  const projectionAdapter = createChatRagProjectionAdapter({
    database,
    config: config.rag,
    createEmbeddings,
    chunker,
    repository,
  });
  const privacyStore = Object.freeze({
    name: "rag",
    async purge({ userId, presetId, client }) {
      await repository.deleteAllProjectionStages(userId, presetId, { client });
      return repository.deleteAllChunks(userId, presetId, { client });
    },
    verifyPurged: async ({ userId, presetId }) => (
      (await repository.countChunks(userId, presetId)) === 0
      && (await repository.countProjectionStages(userId, presetId)) === 0
    ),
  });

  return Object.freeze({
    retrieve: retriever.retrieveChatRagContext,
    requestTurnIndexing: indexer.requestChatTurnIndexing,
    requestDeleteFromMessage: indexer.requestDeleteChunksFromMessageId,
    projectionAdapter,
    privacyStore,
    getHealthSnapshot: () => Object.freeze({
      embeddingProvider: embeddingHealth.snapshot(),
    }),
    admin: Object.freeze({
      indexChatTurn: indexer.indexChatTurn,
      deleteChunksFromMessageId: indexer.deleteChunksFromMessageId,
      listExistingTurnKeys: repository.listExistingTurnKeys,
    }),
  });
}

module.exports = { createChatRagModule };
