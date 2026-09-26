const modelId = "gemini-3.1-pro-preview";
const reasoningEfforts = ["low", "medium", "high"];
const defaultReasoningEffort = "low";

// Keep gateway-specific wire parameters here, outside the shared transport.
// Native Gemini fields and other providers' extensions must not leak through.
const bodyParameters = new Set(["temperature", "top_p", "max_tokens", "reasoning_effort"]);

function buildBodyExtensions({ model, settings } = {}) {
  if (model !== modelId) throw new Error(`Unsupported BotCF model: ${model}`);
  const effort = settings?.reasoningEffort ?? defaultReasoningEffort;
  if (!reasoningEfforts.includes(effort)) {
    throw new Error(`Invalid reasoningEffort for model ${model}: ${effort}. Allowed values: ${reasoningEfforts.join(", ")}`);
  }
  return { reasoning_effort: effort };
}

module.exports = {
  id: "botcf",
  name: "BotCF (Gemini)",
  adapter: "openai-compatible",
  apiKeyEnv: ["BOTCF_API_KEY"],
  baseUrlEnv: ["BOTCF_BASE_URL"],
  openaiCompatible: { bodyExtensions: buildBodyExtensions },
  parameterPolicy: {
    isBodyParamAllowed: ({ model, paramName }) => model === modelId && bodyParameters.has(paramName),
  },
  settingsSchema: [
    {
      key: "temperature", label: "Temperature", type: "range",
      min: 0, max: 2, step: 0.1, decimals: 1, capability: "temperature",
    },
    {
      key: "topP", label: "Top P", type: "range",
      min: 0, max: 1, step: 0.05, decimals: 2, capability: "topP",
    },
    {
      key: "maxOutputTokens", label: "Max Output Tokens", type: "number",
      min: 128, max: 65536, step: 64, capability: "maxTokens",
    },
    {
      key: "reasoningEffort", label: "Reasoning Effort", type: "select",
      options: reasoningEfforts.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
      default: defaultReasoningEffort, capability: "thinking",
    },
    { key: "stream", label: "Streaming", type: "toggle", capability: "stream" },
  ],
  models: [{
    id: modelId, name: modelId, reasoningEfforts,
    defaults: { reasoningEffort: defaultReasoningEffort },
  }],
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: false,
    frequencyPenalty: false,
    webSearch: false,
    tools: false,
    thinking: true,
  },
};
