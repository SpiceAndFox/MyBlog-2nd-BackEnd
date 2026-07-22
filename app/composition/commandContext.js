const { loadEnvironment } = require("./environment");
const { loadApplicationConfig, configureApplicationConfig } = require("../../config");
const databaseEntry = require("../../db");
const { createLogger, configureLogger } = require("../../logger");
const { configureProviderEnvironment } = require("../../services/llm/providers");
const { configureOpenRouterAttribution } = require("../../services/llm/providers/openrouter/headers");
const { configureProductionModelPolicy } = require("../../services/chat/productionModelPolicy");

function createCommandContext({ environment, loadDotenv } = {}) {
  const loadedEnvironment = loadEnvironment({
    environment: environment || process.env,
    loadDotenv: loadDotenv ?? environment === undefined,
  });
  const config = loadApplicationConfig(loadedEnvironment);
  configureApplicationConfig(config);
  configureProviderEnvironment(loadedEnvironment);
  configureOpenRouterAttribution({
    siteUrl: loadedEnvironment.OPENROUTER_SITE_URL,
    appName: loadedEnvironment.OPENROUTER_APP_NAME,
  });
  configureProductionModelPolicy(loadedEnvironment);

  const database = databaseEntry.createDatabase(config.databaseConfig);
  databaseEntry.configureDatabase(database);
  const logger = createLogger({ config: config.logConfig });
  configureLogger(logger);
  return Object.freeze({ config, database, environment: loadedEnvironment, logger });
}

module.exports = { createCommandContext };
