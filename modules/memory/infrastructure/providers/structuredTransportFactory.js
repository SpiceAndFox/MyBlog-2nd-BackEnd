const { initializeProviderConfig } = require("./policies/resolveProviderPolicy");
const { createOpenAiCompatibleTransport } = require("./transport/openAiCompatibleTransport");
const { createDeepSeekStrictToolsTransport } = require("./transport/deepSeekStrictToolsTransport");

const FACTORIES = Object.freeze({
  "openai-compatible-json-schema": createOpenAiCompatibleTransport,
  "openai-compatible-json-object": createOpenAiCompatibleTransport,
  "deepseek-strict-tools": createDeepSeekStrictToolsTransport,
});

function createStructuredTransport(config, overrides = {}) {
  const normalized = initializeProviderConfig({ ...config, ...overrides });
  return FACTORIES[normalized.adapter](normalized);
}

module.exports = { createStructuredTransport };
