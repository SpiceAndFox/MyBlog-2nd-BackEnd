const { createChatSettingsService } = require("./settings");
const { createChatContextCompiler } = require("./contextCompiler");
const { createSendMessageUseCase } = require("./sendMessage");

function createChatModule({ config, adapters } = {}) {
  if (!config?.chat || !config?.llm || !config?.memory) throw new Error("Chat module config is required");
  if (!adapters || typeof adapters !== "object") throw new Error("Chat module adapters are required");

  const settings = createChatSettingsService({
    config: config.chat,
    presetRepository: adapters.presetRepository,
    providers: adapters.providers,
    models: adapters.models,
    schema: adapters.settingsSchema,
    isModelAllowed: adapters.isModelAllowed,
  });
  const compileContext = adapters.compileContext || createChatContextCompiler({
    memoryEnabled: config.memory.enabled,
    memory: adapters.memory,
    rag: { retrieve: adapters.rag.retrieve },
    recentWindow: adapters.recentWindow,
    segments: adapters.contextSegments,
    timeContext: adapters.timeContext,
    gist: { scheduleBackfill: adapters.gist.scheduleBackfill },
  });
  const sendMessage = createSendMessageUseCase({
    chatRepository: adapters.chatRepository,
    settings,
    compileContext,
    llm: adapters.llm,
    memory: adapters.memory,
    rag: adapters.rag,
    gist: adapters.gist,
    scopeCoordinator: adapters.scopeCoordinator,
    logger: adapters.logger,
    timeoutMs: config.llm.timeoutMs,
  });

  return Object.freeze({ sendMessage, settings });
}

module.exports = { createChatModule };
