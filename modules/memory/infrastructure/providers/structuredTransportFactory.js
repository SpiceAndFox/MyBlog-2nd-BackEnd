const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { createDeepSeekStrictToolsTransport } = require("./deepSeekStrictToolsTransport");
const { createOpencodeGoStructuredTransport } = require("./opencodeGoStructuredTransport");

const FACTORIES = Object.freeze({
  "openai-json-schema": createOpenAiStructuredTransport,
  "deepseek-strict-tools": createDeepSeekStrictToolsTransport,
  "opencode-go-json-schema": createOpencodeGoStructuredTransport,
});

function createStructuredTransport(config, overrides = {}) {
  const factory = FACTORIES[config?.adapter];
  if (!factory) throw new Error(`Unsupported Memory Provider adapter: ${config?.adapter || "<missing>"}`);
  return factory({ ...config, ...overrides });
}

module.exports = { createStructuredTransport };
