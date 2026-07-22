const { createUserTimeZoneReader } = require("../../modules/auth");
const {
  createChatMemoryAdapters,
  createChatMemorySourceReader,
  createChatScopeCoordinator,
} = require("../../modules/chat");
const { createMemoryModule } = require("../../modules/memory");

function createChatMemoryRuntime({
  config,
  recentWindowMaxChars,
  logger,
  memoryModule,
  ragProjectionAdapter,
  privacyStores = [],
  enqueueByKey,
} = {}) {
  if (!config || typeof config !== "object") throw new Error("Memory runtime config is required");
  if (!logger?.error) throw new Error("Memory runtime logger is required");
  if (!memoryModule?.createRuntime || !memoryModule?.createContextAssembly || !memoryModule?.createProjectionDrain) {
    throw new Error("An explicitly created Memory module is required");
  }

  const projectionDrains = config.enabled
    ? { rag: memoryModule.createProjectionDrain("rag", ragProjectionAdapter) }
    : {};
  const runtime = memoryModule.createRuntime({
    config,
    projectionDrains,
    privacyStores,
    enqueueByKey,
    onBackgroundError: (error) => logger.error("memory_v2_background_failed", { error }),
  });
  const assembleContext = config.enabled
    ? memoryModule.createContextAssembly({
      runtime,
      config,
      recentWindowMaxChars,
      onBackgroundError: (error) => logger.error("memory_v2_housekeeping_failed", { error }),
    })
    : async () => {
      throw new Error("Memory context assembly is unavailable while Memory v2 is disabled");
    };

  return Object.freeze({ ...runtime, assembleContext });
}

function createMemoryPorts(database) {
  return {
    sourceReader: createChatMemorySourceReader({ database }),
    userTimeZoneReader: createUserTimeZoneReader({ database }),
  };
}

function createMemoryAdministrationComposition({ database } = {}) {
  const { createMemoryAdministration } = require("../../modules/memory/admin");
  return createMemoryAdministration({ database, ...createMemoryPorts(database) });
}

function createMemoryRuntimeComposition({ database, config, chatConfig, logger, scopeCoordinator, chatRag } = {}) {
  const coordinator = scopeCoordinator || createChatScopeCoordinator();
  const chatAdapters = createChatMemoryAdapters({
    database,
    scopeCoordinator: coordinator,
    ragProjectionAdapter: chatRag?.projectionAdapter,
    ragPrivacyStore: chatRag?.privacyStore,
  });
  const memoryModule = createMemoryModule({
    database,
    sourceReader: chatAdapters.sourceReader,
    userTimeZoneReader: createUserTimeZoneReader({ database }),
  });
  return createChatMemoryRuntime({
    config,
    recentWindowMaxChars: chatConfig?.recentWindowMaxChars,
    logger,
    memoryModule,
    ragProjectionAdapter: chatAdapters.ragProjectionAdapter,
    privacyStores: chatAdapters.privacyStores,
    enqueueByKey: chatAdapters.enqueueByKey,
  });
}

module.exports = {
  createChatMemoryRuntime,
  createMemoryAdministrationComposition,
  createMemoryRuntimeComposition,
};
