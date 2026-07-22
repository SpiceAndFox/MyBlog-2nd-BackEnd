const ADAPTER_IDS = Object.freeze(["openai-json-schema", "deepseek-strict-tools"]);
const PROPOSER_IDS = Object.freeze([
  "currentStateProposer",
  "todoProposer",
  "agreementProposer",
  "episodeProposer",
  "profileRelationshipProposer",
  "worldFactProposer",
  "compactionProposer",
]);

function requiredString(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function requiredInt(env, name, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") throw new Error(`Missing required env: ${name}`);
  if (!/^-?\d+$/.test(String(raw).trim())) throw new Error(`Env ${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Env ${name} must be a safe integer >= ${min}`);
  return value;
}

function optionalInt(env, name, fallback, { min = 0 } = {}) {
  if (env[name] === undefined || String(env[name]).trim() === "") return fallback;
  return requiredInt(env, name, { min });
}

function optionalProposerModels(env) {
  const name = "CHAT_MEMORY_V2_PROPOSER_MODELS_JSON";
  const raw = String(env[name] ?? "").trim();
  if (!raw) return Object.freeze({});
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Env ${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Env ${name} must be a JSON object`);
  }
  const models = {};
  for (const [proposer, value] of Object.entries(parsed)) {
    if (!PROPOSER_IDS.includes(proposer)) {
      throw new Error(`Env ${name} contains unsupported proposer: ${proposer}`);
    }
    const model = typeof value === "string" ? value.trim() : "";
    if (!model) throw new Error(`Env ${name}.${proposer} must be a non-empty model id`);
    models[proposer] = model;
  }
  return Object.freeze(models);
}

function resolveMemoryProviderModel(providerConfig, proposer) {
  const proposerId = String(proposer ?? "").trim();
  return providerConfig?.proposerModels?.[proposerId] || providerConfig?.model;
}

function loadMemoryProviderConfig(env = {}) {
  const adapter = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_ADAPTER");
  if (!ADAPTER_IDS.includes(adapter)) {
    throw new Error(`Env CHAT_MEMORY_V2_PROVIDER_ADAPTER must be one of: ${ADAPTER_IDS.join(", ")}`);
  }
  const config = {
    adapter,
    baseUrl: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_BASE_URL"),
    apiKey: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_API_KEY"),
    model: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_MODEL"),
    proposerModels: optionalProposerModels(env),
    timeoutMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS", { min: 1 }),
    maxInputTokens: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS", { min: 1_000_000 }),
    maxOutputTokens: optionalInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS", 8192, { min: 1 }),
  };
  if (adapter === "deepseek-strict-tools") {
    const thinkingMode = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_THINKING_MODE").toLowerCase();
    if (thinkingMode !== "disabled") {
      throw new Error("Env CHAT_MEMORY_V2_PROVIDER_THINKING_MODE must be disabled for Memory proposers");
    }
    config.thinkingMode = thinkingMode;
  }
  return Object.freeze(config);
}

module.exports = {
  ADAPTER_IDS,
  PROPOSER_IDS,
  loadMemoryProviderConfig,
  resolveMemoryProviderModel,
};
