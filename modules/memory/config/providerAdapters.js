const ADAPTER_IDS = Object.freeze([
  "openai-compatible-json-schema",
  "openai-compatible-json-object",
  "deepseek-strict-tools",
]);

// Compatibility is confined to the configuration boundary; requests and reports
// use canonical IDs. In particular, old OpenCode IDs retain their gateway policy.
const ALIASES = Object.freeze({
  "openai-json-schema": { adapter: "openai-compatible-json-schema", profile: "generic" },
  "opencode-go-json-schema": { adapter: "openai-compatible-json-schema", profile: "opencode-go" },
  "opencode-go-json-object": { adapter: "openai-compatible-json-object", profile: "opencode-go" },
});

function normalizeProviderAdapter(config) {
  const alias = Object.hasOwn(ALIASES, config?.adapter) ? ALIASES[config.adapter] : null;
  const adapter = alias?.adapter ?? config?.adapter;
  if (!ADAPTER_IDS.includes(adapter)) {
    throw new Error(`Env CHAT_MEMORY_V2_PROVIDER_ADAPTER must be one of: ${ADAPTER_IDS.join(", ")}`);
  }
  const normalized = { ...config, adapter, profile: config.profile || alias?.profile || "generic" };
  if (config.adapter === "openai-json-schema") {
    delete normalized.reasoningEffort;
    delete normalized.thinkingMode;
  }
  return normalized;
}

module.exports = { ADAPTER_IDS, normalizeProviderAdapter };
