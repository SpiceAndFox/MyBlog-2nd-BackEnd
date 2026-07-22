const { createChatModule } = require("../../modules/chat");

function createChatComposition({ config, memoryRuntime, logger, authMiddleware, adapters = {} } = {}) {
  if (!config || !memoryRuntime || !logger || typeof authMiddleware !== "function") {
    throw new Error("Chat composition dependencies are required");
  }
  // Legacy adapters still read the installed application config while the Chat
  // slice is migrated. Load them only after the composition root installs it.
  const chatModel = require("../../models/chatModel");
  const chatPresetModel = require("../../models/chatPresetModel");
  const providers = require("../../services/llm/providers");
  const models = require("../../services/llm/models");
  const settingsSchema = require("../../services/llm/settingsSchema");
  const llmCompletions = require("../../services/llm/chatCompletions");
  const { isChatModelAllowed } = require("../../services/chat/productionModelPolicy");
  const { buildRecentWindowContext } = require("../../services/chat/context/buildRecentWindowContext");
  const { buildContextSegments } = require("../../services/chat/context/segmentRegistry");
  const { buildTimeContextState } = require("../../services/chat/context/buildTimeContextState");
  const { scheduleAssistantGistBackfill, requestAssistantGistGeneration } = require("../../services/chat/gistPipeline");
  const { retrieveChatRagContext } = require("../../services/chat/rag/retriever");
  const { requestChatTurnIndexing } = require("../../services/chat/rag/indexer");
  const scopeCoordinator = require("../../services/chat/scopeCoordinator");
  const { createChatController } = require("../../controllers/chatController");
  const { createChatRouter } = require("../../routes/chat");
  const uploadPresetAvatar = require("../../middleware/uploadChatPresetAvatar");
  const chatModule = adapters.chatModule || createChatModule({
    config: {
      chat: config.chatConfig,
      llm: config.llmConfig,
      memory: config.memoryV2Config,
    },
    adapters: {
      chatRepository: adapters.chatRepository || chatModel,
      presetRepository: adapters.presetRepository || chatPresetModel,
      providers: adapters.providers || providers,
      models: adapters.models || models,
      settingsSchema: adapters.settingsSchema || settingsSchema,
      isModelAllowed: adapters.isModelAllowed || isChatModelAllowed,
      memory: memoryRuntime,
      recentWindow: { build: adapters.buildRecentWindowContext || buildRecentWindowContext },
      contextSegments: { build: adapters.buildContextSegments || buildContextSegments },
      timeContext: { build: adapters.buildTimeContextState || buildTimeContextState },
      rag: {
        retrieve: adapters.retrieveChatRagContext || retrieveChatRagContext,
        requestTurnIndexing: adapters.requestChatTurnIndexing || requestChatTurnIndexing,
      },
      gist: {
        scheduleBackfill: adapters.scheduleAssistantGistBackfill || scheduleAssistantGistBackfill,
        requestGeneration: adapters.requestAssistantGistGeneration || requestAssistantGistGeneration,
      },
      llm: {
        complete: adapters.createChatCompletion || llmCompletions.createChatCompletion,
        createStreamResponse:
          adapters.createChatCompletionStreamResponse || llmCompletions.createChatCompletionStreamResponse,
        streamDeltas: adapters.streamChatCompletionDeltas || llmCompletions.streamChatCompletionDeltas,
      },
      scopeCoordinator: adapters.scopeCoordinator || scopeCoordinator,
      logger,
    },
  });
  const controller = adapters.controller || createChatController({ chatModule });
  const router = adapters.router || createChatRouter({
    authMiddleware,
    chatController: controller,
    uploadPresetAvatar: adapters.uploadPresetAvatar || uploadPresetAvatar,
  });
  return Object.freeze({ chatModule, controller, router });
}

module.exports = { createChatComposition };
