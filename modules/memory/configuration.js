const { loadMemoryV2Config: parseMemoryConfig } = require("./config/loadConfig");
const { loadMemoryProviderConfig: parseProviderConfig } = require("./config/loadProviderConfig");
const { initializeProviderConfig } = require("./infrastructure/providers/policies/resolveProviderPolicy");

// Public configuration composition: parsing remains infrastructure-independent;
// gateway/model validation still completes before application startup or tools.
function loadMemoryProviderConfig(env = {}) {
  return initializeProviderConfig(parseProviderConfig(env));
}

function loadMemoryV2Config(env = {}) {
  const config = parseMemoryConfig(env);
  if (!config.enabled) return config;
  return Object.freeze({ ...config, provider: initializeProviderConfig(config.provider) });
}

module.exports = { loadMemoryProviderConfig, loadMemoryV2Config };
