const { LIBRARIAN_PROPOSER } = require("../contracts/constants");

const { ADAPTER_IDS, normalizeProviderAdapter } = require("./providerAdapters");
const { REASONING_EFFORT_VALUES, THINKING_MODE_VALUES } = require("./providerSettingValues");
const PROPOSER_IDS = Object.freeze([
  "currentStateProposer",
  "todoProposer",
  "agreementProposer",
  "episodeProposer",
  "profileRelationshipProposer",
  "userProfileProposer",
  "assistantProfileProposer",
  "relationshipProposer",
  "worldFactProposer",
  "compactionProposer",
  LIBRARIAN_PROPOSER,
]);
// 三个 Profile 专家未单独覆盖时，继承 profileRelationshipProposer 的整条覆盖。
const PROFILE_INHERIT_PROPOSERS = Object.freeze(["userProfileProposer", "assistantProfileProposer", "relationshipProposer"]);

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

function parseReasoningEffort(label, value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!REASONING_EFFORT_VALUES.includes(effort)) {
    throw new Error(`Env ${label} must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`);
  }
  return effort;
}

function parseThinkingMode(label, value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!THINKING_MODE_VALUES.includes(mode)) {
    throw new Error(`Env ${label} must be one of: ${THINKING_MODE_VALUES.join(", ")}`);
  }
  return mode;
}

// 每个 proposer 的覆盖支持两种形态：
//   "model-id"                                   —— 仅覆盖模型（向后兼容）
//   { model, reasoningEffort, thinkingMode } —— 各项均可单独省略
function parseProposerOverride(name, proposer, value, adapter) {
  if (typeof value === "string") {
    const model = value.trim();
    if (!model) throw new Error(`Env ${name}.${proposer} must be a non-empty model id`);
    return model;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Env ${name}.${proposer} must be a non-empty model id or an override object`);
  }
  for (const key of Object.keys(value)) {
    if (!["model", "reasoningEffort", "thinkingMode"].includes(key)) {
      throw new Error(`Env ${name}.${proposer} contains unsupported key: ${key}`);
    }
  }
  const override = {};
  if (value.model !== undefined) {
    const model = typeof value.model === "string" ? value.model.trim() : "";
    if (!model) throw new Error(`Env ${name}.${proposer}.model must be a non-empty model id`);
    override.model = model;
  }
  if (value.reasoningEffort !== undefined) {
    if (adapter === "deepseek-strict-tools") {
      const effort = String(value.reasoningEffort).trim();
      if (!["low", "high", "max"].includes(effort)) throw new Error("DeepSeek reasoning effort must be low, high or max");
      override.reasoningEffort = effort;
    }
    if (adapter !== "deepseek-strict-tools") override.reasoningEffort = value.reasoningEffort === null
      ? null : parseReasoningEffort(`${name}.${proposer}.reasoningEffort`, value.reasoningEffort);
  }
  if (value.thinkingMode !== undefined) {
    if (adapter === "deepseek-strict-tools") throw new Error("DeepSeek proposer thinkingMode overrides are not supported");
    override.thinkingMode = value.thinkingMode === null
      ? null : parseThinkingMode(`${name}.${proposer}.thinkingMode`, value.thinkingMode);
  }
  if (!Object.keys(override).length) {
    throw new Error(`Env ${name}.${proposer} must override model, reasoningEffort, or thinkingMode`);
  }
  return Object.freeze(override);
}

function optionalProposerModels(env, adapter) {
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
    models[proposer] = parseProposerOverride(name, proposer, value, adapter);
  }
  return Object.freeze(models);
}

// 覆盖条目保持配置书写的形态（字符串或对象），解析时对两种形态都宽容。
function proposerOverride(providerConfig, proposer) {
  const proposerId = String(proposer ?? "").trim();
  const overrides = providerConfig?.proposerModels ?? {};
  const explicit = overrides[proposerId];
  if (explicit) return explicit;
  if (PROFILE_INHERIT_PROPOSERS.includes(proposerId)) return overrides.profileRelationshipProposer ?? null;
  return null;
}

function resolveMemoryProviderModel(providerConfig, proposer) {
  const override = proposerOverride(providerConfig, proposer);
  const model = typeof override === "string" ? override : override?.model;
  return model || providerConfig?.model;
}

function resolveMemoryProviderReasoningEffort(providerConfig, proposer) {
  const override = proposerOverride(providerConfig, proposer);
  if (override && typeof override === "object" && Object.hasOwn(override, "reasoningEffort")) {
    return override.reasoningEffort ?? undefined;
  }
  return providerConfig?.reasoningEffort;
}

function resolveMemoryProviderThinkingMode(providerConfig, proposer) {
  const override = proposerOverride(providerConfig, proposer);
  if (override && typeof override === "object" && Object.hasOwn(override, "thinkingMode")) {
    return override.thinkingMode ?? undefined;
  }
  return providerConfig?.thinkingMode;
}

// Advanced overrides are parsed as data here. Their rule vocabulary and model
// compatibility are validated by the provider layer during initialization.
function parsePolicyJson(raw, label) {
  if (!String(raw ?? "").trim()) return Object.freeze({});
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.freeze(value);
}

function loadMemoryProviderConfig(env = {}) {
  const requestedAdapter = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_ADAPTER");
  const { adapter, profile } = normalizeProviderAdapter({
    adapter: requestedAdapter, profile: String(env.CHAT_MEMORY_V2_PROVIDER_PROFILE ?? "").trim(),
  });
  const config = {
    adapter,
    profile,
    baseUrl: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_BASE_URL"),
    apiKey: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_API_KEY"),
    model: requiredString(env, "CHAT_MEMORY_V2_PROVIDER_MODEL"),
    proposerModels: optionalProposerModels(env, adapter),
    timeoutMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS", { min: 1 }),
    maxInputTokens: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS", { min: 100_000 }),
    maxOutputTokens: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS", { min: 1 }),
  };
  if (adapter === "deepseek-strict-tools") {
    config.thinkingMode = parseThinkingMode(
      "CHAT_MEMORY_V2_PROVIDER_THINKING_MODE",
      requiredString(env, "CHAT_MEMORY_V2_PROVIDER_THINKING_MODE"),
    );
    const effort = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT");
    if (!["low", "high", "max"].includes(effort)) throw new Error("DeepSeek reasoning effort must be low, high or max");
    config.reasoningEffort = effort;
  }
  if (adapter !== "deepseek-strict-tools") {
    config.policy = parsePolicyJson(env.CHAT_MEMORY_V2_PROVIDER_POLICY_JSON, "CHAT_MEMORY_V2_PROVIDER_POLICY_JSON");
    config.modelRules = parsePolicyJson(env.CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON, "CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON");
    // The former standard adapter never sent inference controls. Its alias keeps
    // that behavior even when a shared environment contains DeepSeek settings.
    if (requestedAdapter !== "openai-json-schema") {
      for (const [field, suffix, parse] of [
        ["reasoningEffort", "REASONING_EFFORT", parseReasoningEffort],
        ["thinkingMode", "THINKING_MODE", parseThinkingMode],
      ]) {
        const name = `CHAT_MEMORY_V2_PROVIDER_${suffix}`;
        if (String(env[name] ?? "").trim()) config[field] = parse(name, env[name]);
      }
    }
  }
  return Object.freeze(config);
}

module.exports = {
  ADAPTER_IDS,
  PROPOSER_IDS,
  REASONING_EFFORT_VALUES,
  THINKING_MODE_VALUES,
  loadMemoryProviderConfig,
  resolveMemoryProviderModel,
  resolveMemoryProviderReasoningEffort,
  resolveMemoryProviderThinkingMode,
};
