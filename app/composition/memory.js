const { createUserTimeZoneReader } = require("../../modules/auth");
const {
  createChatMemoryAdapters,
  createChatMemorySourceReader,
  createChatScopeCoordinator,
} = require("../../modules/chat");
const { createMemoryModule } = require("../../modules/memory");
const memoryRuntimeEntry = require("../../services/chat/memoryRuntime");

function createMemoryPorts(database) {
  return {
    sourceReader: createChatMemorySourceReader({ database }),
    userTimeZoneReader: createUserTimeZoneReader({ database }),
  };
}

function createMemoryAdministrationComposition({ database } = {}) {
  const { createMemoryAdministration } = require("../../modules/memory/admin");
  return createMemoryAdministration(createMemoryPorts(database));
}

function createMemoryRuntimeComposition({ database, config, chatConfig, logger, scopeCoordinator } = {}) {
  const coordinator = scopeCoordinator || createChatScopeCoordinator();
  const chatAdapters = createChatMemoryAdapters({ database, scopeCoordinator: coordinator });
  const memoryModule = createMemoryModule({
    sourceReader: chatAdapters.sourceReader,
    userTimeZoneReader: createUserTimeZoneReader({ database }),
  });
  return memoryRuntimeEntry.createChatMemoryRuntime({
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
  createMemoryAdministrationComposition,
  createMemoryRuntimeComposition,
};
