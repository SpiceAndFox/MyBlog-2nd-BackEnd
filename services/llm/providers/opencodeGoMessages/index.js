const MODELS = [
  { id: "minimax-m3", name: "MiniMax M3" },
  { id: "minimax-m2.7", name: "MiniMax M2.7" },
  { id: "minimax-m2.5", name: "MiniMax M2.5" },
  { id: "qwen3.7-max", name: "Qwen3.7 Max" },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
];

const BLOCKED_BODY_PARAMS = ["presence_penalty", "frequency_penalty", "tools"];

function hasFiniteSetting(settings, key) {
  return Number.isFinite(Number(settings?.[key]));
}

function isBodyParamAllowed({ paramName, settings } = {}) {
  if (BLOCKED_BODY_PARAMS.includes(paramName)) return false;

  if (paramName === "top_p" && hasFiniteSetting(settings, "temperature")) return false;

  return true;
}

module.exports = {
  id: "opencode-go-messages",
  name: "OpenCode Go (Messages)",
  adapter: "anthropic-messages",
  apiKeyEnv: ["OPENCODE_API_KEY"],
  baseUrlEnv: ["OPENCODE_GO_BASE_URL"],
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
    },
    {
      key: "maxOutputTokens",
      label: "Max Output Tokens",
      type: "number",
      min: 128,
      max: 128000,
      step: 1024,
      capability: "maxTokens",
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
  ],
  models: MODELS,
  parameterPolicy: {
    blockedBodyParams: BLOCKED_BODY_PARAMS,
    isBodyParamAllowed,
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: false,
    frequencyPenalty: false,
    webSearch: false,
    tools: false,
    thinking: false,
  },
};
