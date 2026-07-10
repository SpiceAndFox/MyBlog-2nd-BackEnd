const MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
];

const NO_SAMPLING_PARAMETER_MODELS = ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"];

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function hasFiniteSetting(settings, key) {
  return Number.isFinite(Number(settings?.[key]));
}

function modelRejectsSamplingParameters(modelId) {
  return NO_SAMPLING_PARAMETER_MODELS.includes(normalizeModelId(modelId));
}

function isBodyParamAllowed({ model, paramName, settings } = {}) {
  if (paramName === "presence_penalty" || paramName === "frequency_penalty") return false;

  if (paramName === "tools") {
    return Boolean(settings?.enableWebSearch);
  }

  if (paramName === "temperature" || paramName === "top_p") {
    if (modelRejectsSamplingParameters(model)) return false;

    // Anthropic recommends changing either temperature or top_p, not both.
    // Prefer temperature when both are present because existing defaults set it.
    if (paramName === "top_p" && hasFiniteSetting(settings, "temperature")) return false;
  }

  return true;
}

module.exports = {
  id: "opencode-zen-claude",
  name: "OpenCode Zen (Claude)",
  adapter: "anthropic-messages",
  apiKeyEnv: ["OPENCODE_ZEN_API_KEY"],
  baseUrlEnv: ["OPENCODE_ZEN_MESSAGES_BASE_URL"],
  settingsSchema: [
    {
      key: "temperature",
      label: "Temperature",
      type: "range",
      min: 0,
      max: 1,
      step: 0.1,
      decimals: 1,
      capability: "temperature",
      modelBlocklist: NO_SAMPLING_PARAMETER_MODELS,
    },
    {
      key: "topP",
      label: "Top P",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      decimals: 2,
      capability: "topP",
      modelBlocklist: NO_SAMPLING_PARAMETER_MODELS,
    },
    {
      key: "maxOutputTokens",
      label: "Max Output Tokens",
      type: "number",
      min: 128,
      max: 128000,
      step: 128,
      capability: "maxTokens",
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
    {
      key: "enableWebSearch",
      label: "Web Search (Anthropic)",
      type: "toggle",
      capability: "webSearch",
    },
    {
      key: "webSearchMaxUses",
      label: "Web Search Max Uses",
      type: "number",
      min: 1,
      max: 20,
      step: 1,
      default: 5,
      capability: "webSearch",
    },
  ],
  models: MODELS,
  parameterPolicy: {
    blockedBodyParams: ["presence_penalty", "frequency_penalty"],
    isBodyParamAllowed,
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: false,
    frequencyPenalty: false,
    webSearch: true,
    tools: false,
    thinking: false,
  },
};
