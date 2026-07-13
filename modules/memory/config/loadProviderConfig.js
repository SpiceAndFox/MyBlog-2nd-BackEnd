const ADAPTER_IDS = Object.freeze(["openai-json-schema", "deepseek-strict-tools"]);

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

function loadMemoryProviderConfig(env = process.env) {
  const adapter = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_ADAPTER");
  if (!ADAPTER_IDS.includes(adapter)) {
    throw new Error(`Env CHAT_MEMORY_V2_PROVIDER_ADAPTER must be one of: ${ADAPTER_IDS.join(", ")}`);
  }
  const config = {
    adapter,
    baseUrl: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_BASE_URL"),
    apiKey: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_API_KEY"),
    model: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_MODEL"),
    timeoutMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS", { min: 1 }),
    maxInputTokens: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS", { min: 1_000_000 }),
  };
  if (adapter === "deepseek-strict-tools") {
    const thinkingMode = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_THINKING_MODE").toLowerCase();
    if (!["disabled", "enabled"].includes(thinkingMode)) {
      throw new Error("Env CHAT_MEMORY_V2_PROVIDER_THINKING_MODE must be disabled or enabled");
    }
    config.thinkingMode = thinkingMode;
  }
  return Object.freeze(config);
}

module.exports = { ADAPTER_IDS, loadMemoryProviderConfig };
