const { createChatSettingsService } = require("./settings");
const { createChatContextCompiler } = require("./contextCompiler");
const { createSendMessageUseCase } = require("./sendMessage");
const { createEditMessageUseCase } = require("./editMessage");
const { createGetChatMetaUseCase } = require("./meta");
const { createGetPrivacyOperationUseCase } = require("./privacy");
const { createPresetUseCases } = require("./presets");
const { createSessionUseCases } = require("./sessions");
const { createChatGistService } = require("./gist");
const { createChatTrashCleanup } = require("./trashCleanup");
const { createRecentWindowContextBuilder } = require("./context/buildRecentWindowContext");
const { createContextSegmentBuilder } = require("./context/segmentRegistry");
const { buildTimeContextState } = require("./context/buildTimeContextState");

function createChatModule({ config, adapters } = {}) {
  if (!config?.chat || !config?.llm || !config?.memory || !config?.context || !config?.gist || !config?.timeContext) {
    throw new Error("Chat module config is required");
  }
  if (!adapters || typeof adapters !== "object") throw new Error("Chat module adapters are required");

  const settings = createChatSettingsService({
    config: config.chat,
    presetRepository: adapters.presetRepository,
    providers: adapters.providers,
    models: adapters.models,
    schema: adapters.settingsSchema,
    isModelAllowed: adapters.isModelAllowed,
  });
  const gist = adapters.gist || createChatGistService({
    config: config.gist,
    contextConfig: config.context,
    chatRepository: adapters.chatRepository,
    gistRepository: adapters.gistRepository,
    llm: { complete: adapters.llm.complete },
    taskQueue: adapters.taskQueue,
    text: adapters.text,
    logger: adapters.logger,
  });
  const compileContext = adapters.compileContext || createChatContextCompiler({
    memoryEnabled: config.memory.enabled,
    memory: adapters.memory,
    rag: { retrieve: adapters.rag.retrieve },
    recentWindow: adapters.recentWindow || { build: createRecentWindowContextBuilder({
      config: config.chat,
      contextConfig: config.context,
      gistConfig: config.gist,
      chatRepository: adapters.chatRepository,
      gistRepository: adapters.gistRepository,
      logger: adapters.logger,
    }) },
    segments: adapters.contextSegments || { build: createContextSegmentBuilder({
      contextConfig: config.context,
      timeContextConfig: config.timeContext,
    }) },
    timeContext: adapters.timeContext || { build: buildTimeContextState },
    gist: { scheduleBackfill: gist.scheduleBackfill },
  });
  const sendMessage = createSendMessageUseCase({
    chatRepository: adapters.chatRepository,
    settings,
    compileContext,
    llm: adapters.llm,
    memory: adapters.memory,
    rag: adapters.rag,
    gist,
    scopeCoordinator: adapters.scopeCoordinator,
    logger: adapters.logger,
    timeoutMs: config.llm.timeoutMs,
  });
  const editMessage = createEditMessageUseCase({
    chatRepository: adapters.chatRepository,
    settings,
    memory: adapters.memory,
    rag: adapters.rag,
    scopeCoordinator: adapters.scopeCoordinator,
    logger: adapters.logger,
  });
  const getMeta = createGetChatMetaUseCase({
    config: config.chat,
    providers: adapters.providers,
    models: adapters.models,
    isModelAllowed: adapters.isModelAllowed,
  });
  const getPrivacyOperation = createGetPrivacyOperationUseCase({ memory: adapters.memory });
  const presets = adapters.presets || createPresetUseCases({
    presetRepository: adapters.presetRepository,
    settings,
    memory: adapters.memory,
    avatarStorage: adapters.avatarStorage,
    scopeCoordinator: adapters.scopeCoordinator,
  });
  const sessions = adapters.sessions || createSessionUseCases({
    chatRepository: adapters.chatRepository,
    settings,
    memory: adapters.memory,
    scopeCoordinator: adapters.scopeCoordinator,
  });
  const trashCleanup = adapters.trashCleanup || createChatTrashCleanup({
    config: config.chat,
    chatRepository: adapters.chatRepository,
    memory: adapters.memory,
    logger: adapters.logger,
  });

  return Object.freeze({
    editMessage,
    getMeta,
    getPrivacyOperation,
    gist,
    presets,
    sendMessage,
    sessions,
    settings,
    trashCleanup,
  });
}

module.exports = { createChatModule };
