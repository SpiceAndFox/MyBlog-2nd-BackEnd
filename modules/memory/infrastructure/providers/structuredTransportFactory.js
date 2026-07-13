const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { createDeepSeekStrictToolsTransport } = require("./deepSeekStrictToolsTransport");

const FACTORIES = Object.freeze({
  "openai-json-schema": createOpenAiStructuredTransport,
  "deepseek-strict-tools": createDeepSeekStrictToolsTransport,
});

function createStructuredTransport(config, overrides = {}) {
  const factory = FACTORIES[config?.adapter];
  if (!factory) throw new Error(`Unsupported Memory Provider adapter: ${config?.adapter || "<missing>"}`);
  return factory({ ...config, ...overrides });
}

module.exports = { createStructuredTransport };
