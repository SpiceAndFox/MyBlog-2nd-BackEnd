const { loadEnvironment } = require("./environment");
const { loadApplicationConfig } = require("../../config");
const databaseEntry = require("../../db");
const { createLogger, configureLogger } = require("../../logger");
const {
  createChatLlmCatalog,
  createChatLlmRuntime,
} = require("../../modules/chat");
const { loadMemoryV2Config } = require("../../modules/memory");

function createCommandContext({ environment, loadDotenv, adapters = {} } = {}) {
  const loadedEnvironment = loadEnvironment({
    environment: environment || process.env,
    loadDotenv: loadDotenv ?? environment === undefined,
  });
  const chatLlmCatalog = adapters.chatLlmCatalog || createChatLlmCatalog({ environment: loadedEnvironment });
  const config = loadApplicationConfig(loadedEnvironment, {
    chatLlmCatalog,
    loadMemoryConfig: loadMemoryV2Config,
  });
  const chatLlm = adapters.chatLlm || createChatLlmRuntime({
    catalog: chatLlmCatalog,
    config: config.llmConfig,
    adapters: adapters.chatLlmAdapters,
  });
  const database = databaseEntry.createDatabase(config.databaseConfig);
  databaseEntry.configureDatabase(database);
  const logger = createLogger({ config: config.logConfig });
  configureLogger(logger);
  return Object.freeze({ chatLlm, config, database, environment: loadedEnvironment, logger });
}

module.exports = { createCommandContext };
