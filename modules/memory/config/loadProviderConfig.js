const ADAPTER_IDS = Object.freeze(["openai-json-schema", "deepseek-strict-tools", "opencode-go-json-schema"]);
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
]);
// 与 chat 模块 opencodeGoOpenai 的 REASONING_EFFORT_OPTIONS 全集保持一致。
const REASONING_EFFORT_VALUES = Object.freeze(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
// 三个 Profile 专家未单独覆盖时，继承 profileRelationshipProposer 的整条覆盖（model 与 reasoningEffort）。
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

function optionalInt(env, name, fallback, { min = 0 } = {}) {
  if (env[name] === undefined || String(env[name]).trim() === "") return fallback;
  return requiredInt(env, name, { min });
}

function parseReasoningEffort(label, value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!REASONING_EFFORT_VALUES.includes(effort)) {
    throw new Error(`Env ${label} must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`);
  }
  return effort;
}

// 每个 proposer 的覆盖支持两种形态：
//   "model-id"                                   —— 仅覆盖模型（向后兼容）
//   { "model": "...", "reasoningEffort": "..." } —— 两者皆可单独省略
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
    if (!["model", "reasoningEffort"].includes(key)) {
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
    if (adapter !== "opencode-go-json-schema") {
      throw new Error(`Env ${name}.${proposer}.reasoningEffort requires the opencode-go-json-schema adapter`);
    }
    override.reasoningEffort = parseReasoningEffort(`${name}.${proposer}.reasoningEffort`, value.reasoningEffort);
  }
  if (!override.model && !override.reasoningEffort) {
    throw new Error(`Env ${name}.${proposer} must override model, reasoningEffort, or both`);
  }
  return override;
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
  const effort = typeof override === "string" ? undefined : override?.reasoningEffort;
  return effort || providerConfig?.reasoningEffort;
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
    proposerModels: optionalProposerModels(env, adapter),
    timeoutMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS", { min: 1 }),
    maxInputTokens: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS", { min: 100_000 }),
    maxOutputTokens: optionalInt(env, "CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS", 8192, { min: 1 }),
  };
  if (adapter === "deepseek-strict-tools") {
    config.thinkingMode = requiredString(env, "CHAT_MEMORY_V2_PROVIDER_THINKING_MODE").toLowerCase();
  }
  if (adapter === "opencode-go-json-schema") {
    config.reasoningEffort = parseReasoningEffort("CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT", env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT);
  }
  return Object.freeze(config);
}

module.exports = {
  ADAPTER_IDS,
  PROPOSER_IDS,
  REASONING_EFFORT_VALUES,
  loadMemoryProviderConfig,
  resolveMemoryProviderModel,
  resolveMemoryProviderReasoningEffort,
};
