const { createAvatarStorage, createChatModule, createChatPersistence, isChatModelAllowed } = require("../../modules/chat");

function createChatComposition({ config, database, memoryRuntime, logger, authMiddleware, withRequestContext, scopeCoordinator, transaction, rag, adapters = {} } = {}) {
  if (!config || !database || !memoryRuntime || !logger || typeof authMiddleware !== "function" || !scopeCoordinator || !transaction || !rag) {
    throw new Error("Chat composition dependencies are required");
  }
  const providers = require("../../services/llm/providers");
  const models = require("../../services/llm/models");
  const settingsSchema = require("../../services/llm/settingsSchema");
  const llmCompletions = require("../../services/llm/chatCompletions");
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
      providers: adapters.providers || providers,
      models: adapters.models || models,
      settingsSchema: adapters.settingsSchema || settingsSchema,
      isModelAllowed: adapters.isModelAllowed || isChatModelAllowed,
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
        complete: adapters.createChatCompletion || llmCompletions.createChatCompletion,
        createStreamResponse:
          adapters.createChatCompletionStreamResponse || llmCompletions.createChatCompletionStreamResponse,
        streamDeltas: adapters.streamChatCompletionDeltas || llmCompletions.streamChatCompletionDeltas,
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
