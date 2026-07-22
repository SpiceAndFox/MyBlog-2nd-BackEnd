const { createAvatarStorage, createChatModule, createChatPersistence } = require("../../modules/chat");

function createChatComposition({ config, database, memoryRuntime, logger, authMiddleware, withRequestContext, scopeCoordinator, transaction, rag, llm, isModelAllowed, adapters = {} } = {}) {
  if (!config || !database || !memoryRuntime || !logger || typeof authMiddleware !== "function" || !scopeCoordinator || !transaction || !rag || !llm || typeof isModelAllowed !== "function") {
    throw new Error("Chat composition dependencies are required");
  }
  const { createChatController } = require("../../controllers/chatController");
  const { createChatRouter } = require("../../routes/chat");
  const uploadPresetAvatar = require("../../middleware/uploadChatPresetAvatar");
  const persistence = adapters.persistence || createChatPersistence({ database });
  const chatRepository = adapters.chatRepository || persistence.chatRepository;
  const presetRepository = adapters.presetRepository || persistence.presetRepository;
  const gistRepository = adapters.gistRepository || persistence.gistRepository;
  const avatarStorage = adapters.avatarStorage || createAvatarStorage();
  const chatModule = adapters.chatModule || createChatModule({
    config: {
      chat: config.chatConfig,
      context: config.chatContextConfig,
      gist: config.chatGistConfig,
      timeContext: config.chatTimeContextConfig,
      llm: config.llmConfig,
      memory: config.memoryV2Config,
    },
    adapters: {
      chatRepository,
      presetRepository,
      gistRepository,
      providers: adapters.providers || llm.providers,
      models: adapters.models || llm.models,
      settingsSchema: adapters.settingsSchema || llm.settingsSchema,
      isModelAllowed: adapters.isModelAllowed || isModelAllowed,
      memory: memoryRuntime,
      recentWindow: adapters.buildRecentWindowContext ? { build: adapters.buildRecentWindowContext } : undefined,
      contextSegments: adapters.buildContextSegments ? { build: adapters.buildContextSegments } : undefined,
      timeContext: adapters.buildTimeContextState ? { build: adapters.buildTimeContextState } : undefined,
      rag: adapters.rag || {
        retrieve: adapters.retrieveChatRagContext || rag.retrieve,
        requestTurnIndexing: adapters.requestChatTurnIndexing || rag.requestTurnIndexing,
        requestDeleteFromMessage: adapters.requestDeleteChunksFromMessageId || rag.requestDeleteFromMessage,
      },
      gist: adapters.gist,
      gistRepository,
      llm: {
        complete: adapters.createChatCompletion || llm.createChatCompletion,
        createStreamResponse:
          adapters.createChatCompletionStreamResponse || llm.createChatCompletionStreamResponse,
        streamDeltas: adapters.streamChatCompletionDeltas || llm.streamChatCompletionDeltas,
      },
      scopeCoordinator,
      transaction,
      taskQueue: adapters.taskQueue,
      text: adapters.text,
      avatarStorage,
      presets: adapters.presets,
      sessions: adapters.sessions,
      trashCleanup: adapters.trashCleanup,
      logger,
    },
  });
  const controller = adapters.controller || createChatController({
    chatModule,
    memory: memoryRuntime,
    config: { rag: config.chatRagConfig },
    logger,
    withRequestContext,
  });
  const router = adapters.router || createChatRouter({
    authMiddleware,
    chatController: controller,
    uploadPresetAvatar: adapters.uploadPresetAvatar || uploadPresetAvatar,
  });
  return Object.freeze({ chatModule, controller, persistence, router, scopeCoordinator });
}

module.exports = { createChatComposition };
