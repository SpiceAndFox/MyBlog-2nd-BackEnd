const thinkingModeOptions = [
  { value: "disabled", label: "Disabled" },
  { value: "enabled", label: "Enabled" },
];

const reasoningEffortOptions = [
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

function normalizeThinkingMode(settings) {
  const raw = String(settings?.thinkingMode || "").trim().toLowerCase();
  return raw === "enabled" ? "enabled" : "disabled";
}

function normalizeReasoningEffort(settings) {
  const raw = String(settings?.reasoningEffort || "").trim().toLowerCase();
  return raw === "max" ? "max" : "high";
}

module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  adapter: "openai-compatible",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: ({ settings } = {}) => {
      const thinkingMode = normalizeThinkingMode(settings);
      const body = { thinking: { type: thinkingMode } };
      if (thinkingMode === "enabled") body.reasoning_effort = normalizeReasoningEffort(settings);
      return body;
    },
  },
  settingsSchema: [
    {
      key: "thinkingMode",
      label: "Thinking Mode",
      type: "select",
      options: thinkingModeOptions,
      default: "disabled",
      capability: "thinking",
    },
    {
      key: "reasoningEffort",
      label: "Reasoning Effort",
      type: "select",
      options: reasoningEffortOptions,
      default: "high",
      capability: "thinking",
    },
    {
      key: "temperature",
      label: "Temperature",
      type: "range",
      min: 0,
      max: 2,
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
      label: "Max Tokens",
      type: "number",
      min: 128,
      max: 384000,
      step: 1024,
      capability: "maxTokens",
    },
    {
      key: "presencePenalty",
      label: "Presence Penalty",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "presencePenalty",
    },
    {
      key: "frequencyPenalty",
      label: "Frequency Penalty",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "frequencyPenalty",
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
  ],
  models: [
    { id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
  ],
  parameterPolicy: {
    blockedBodyParams: [],
    isBodyParamAllowed: ({ paramName, settings }) => {
      if (normalizeThinkingMode(settings) !== "enabled") return true;

      if (["temperature", "top_p", "presence_penalty", "frequency_penalty"].includes(paramName)) return false;
      if (["logprobs", "top_logprobs"].includes(paramName)) return false;
      return true;
    },
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: true,
    frequencyPenalty: true,
    webSearch: false,
    tools: false,
    thinking: true,
  },
};
