require("module-alias/register");

const { loadEnvironment } = require("./environment");
const {
  loadApplicationConfig,
  configureApplicationConfig,
} = require("../../config");
const databaseEntry = require("../../db");
const {
  createLogger,
  configureLogger,
  withRequestContext,
} = require("../../logger");
const {
  createAuthModule,
  createUserTimeZoneReader,
} = require("../../modules/auth");
const { createMemoryModule } = require("../../modules/memory");
const { createChatMemoryAdapters, createChatScopeCoordinator, configureProductionModelPolicy } = require("../../modules/chat");
const { createRequestLogger } = require("../../middleware/requestLogger");
const {
  createHealthState,
  createServerLifecycle,
} = require("./serverLifecycle");
const { createBackgroundServices } = require("./backgroundServices");
const { createHttpApplication } = require("./httpApplication");
const { createArticleTempImageCleanup } = require("../../modules/blog");
const { createChatComposition } = require("./chat");
const { configureProviderEnvironment } = require("../../services/llm/providers");
const { configureOpenRouterAttribution } = require("../../services/llm/providers/openrouter/headers");
function createApplicationComposition({ environment, loadDotenv, adapters = {} } = {}) {
  const startupEnvironment = loadEnvironment({
    environment: environment || process.env,
    loadDotenv: loadDotenv ?? environment === undefined,
  });
  const config = loadApplicationConfig(startupEnvironment);
  configureApplicationConfig(config);
  configureProviderEnvironment(startupEnvironment);
  configureOpenRouterAttribution({
    siteUrl: startupEnvironment.OPENROUTER_SITE_URL,
    appName: startupEnvironment.OPENROUTER_APP_NAME,
  });
  configureProductionModelPolicy(startupEnvironment);

  const memoryRuntimeEntry = require("../../services/chat/memoryRuntime");
  const database = adapters.database || databaseEntry.createDatabase(config.databaseConfig);
  databaseEntry.configureDatabase(database);

  const logger = adapters.logger || createLogger({ config: config.logConfig });
  configureLogger(logger);

  const auth = adapters.auth || createAuthModule({
    config: config.authConfig,
    database,
    logger,
    withRequestContext,
  });

  const scopeCoordinator = adapters.chatScopeCoordinator || createChatScopeCoordinator();
  const chatMemoryAdapters = adapters.chatMemoryAdapters || createChatMemoryAdapters({ database, scopeCoordinator });
  const memoryModule = adapters.memoryModule || createMemoryModule({
    sourceReader: chatMemoryAdapters.sourceReader,
    userTimeZoneReader: auth.userTimeZoneReader || createUserTimeZoneReader({ database }),
  });
  const memoryRuntime = adapters.memoryRuntime || memoryRuntimeEntry.createChatMemoryRuntime({
    config: config.memoryV2Config,
    recentWindowMaxChars: config.chatConfig.recentWindowMaxChars,
    logger,
    memoryModule,
    ragProjectionAdapter: chatMemoryAdapters.ragProjectionAdapter,
    privacyStores: chatMemoryAdapters.privacyStores,
    enqueueByKey: chatMemoryAdapters.enqueueByKey,
  });
  memoryRuntimeEntry.configureChatMemoryRuntime(memoryRuntime);

  const health = adapters.health || createHealthState();
  const requestLogger = createRequestLogger({
    logger,
    logSuccessRequests: config.logConfig.httpSuccessRequests,
  });
  const chat = adapters.chat || (adapters.app ? null : createChatComposition({
    config,
    database,
    memoryRuntime,
    logger,
    authMiddleware: auth.middleware,
    withRequestContext,
    scopeCoordinator,
    adapters: adapters.chatAdapters,
  }));
  const app = adapters.app || createHttpApplication({ health, requestLogger, chatRouter: chat.router, auth });
  const articleTempImageCleanup = createArticleTempImageCleanup({
    logger,
    ttlMs: config.articleConfig.tempImageTtlMs,
    intervalMs: config.articleConfig.cleanupIntervalMs,
  });
  const backgroundServices = createBackgroundServices([
    {
      name: "chat-trash-cleanup",
      start: chat?.chatModule?.trashCleanup?.start || (() => () => {}),
    },
    {
      name: "article-temp-image-cleanup",
      start: articleTempImageCleanup.start,
    },
  ]);

  const lifecycle = createServerLifecycle({
    app,
    memoryRuntime,
    database,
    logger,
    health,
    host: config.serverConfig.host,
    port: config.serverConfig.port,
    shutdownTimeoutMs: config.serverConfig.shutdownTimeoutMs,
    startupEnvironment,
    productionModels: {
      memoryModel: config.memoryV2Config.provider?.model,
      defaultChatProviderId: config.chatConfig.defaultProviderId,
      defaultChatModelId: config.chatConfig.defaultModelByProvider?.[config.chatConfig.defaultProviderId],
    },
    startBackgroundServices: backgroundServices.start,
    cancelInFlight: (reason) => scopeCoordinator.cancelAll(reason),
    waitForInFlight: () => scopeCoordinator.waitForIdle(),
  });

  return Object.freeze({
    app,
    auth,
    chat,
    config,
    database,
    health,
    lifecycle,
    logger,
    memoryModule,
    memoryRuntime,
  });
}

module.exports = { createApplicationComposition };
