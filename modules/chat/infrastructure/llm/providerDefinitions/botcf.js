const modelId = "gemini-3.1-pro-preview";
const reasoningEfforts = ["low", "medium", "high"];
const defaultReasoningEffort = "low";
// Official Argon defaults and OpenAI-compatible thinking mapping (checked 2026-10-14):
// https://ai.google.dev/gemini-api/docs/latest-model
// https://ai.google.dev/gemini-api/docs/openai
// https://ai.google.dev/gemini-api/docs/generate-content/long-decode
const argonModelId = "gemini-4-argon";
const models = [
  { id: modelId, name: modelId, reasoningEfforts, defaults: { reasoningEffort: defaultReasoningEffort } },
  {
    id: argonModelId, name: argonModelId, reasoningEfforts,
    defaults: { reasoningEffort: "medium", maxOutputTokens: 65536 },
    requestTimeoutMs: 1200000,
  },
];

// Keep gateway-specific wire parameters here, outside the shared transport.
// Native Gemini fields and other providers' extensions must not leak through.
const bodyParameters = new Set(["temperature", "top_p", "max_tokens", "reasoning_effort"]);

function buildBodyExtensions({ model, settings } = {}) {
  const definition = models.find(entry => entry.id === model);
  if (!definition) throw new Error(`Unsupported BotCF model: ${model}`);
  const effort = settings?.reasoningEffort ?? definition.defaults.reasoningEffort;
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
    isBodyParamAllowed: ({ model, paramName }) => {
      if (!models.some(entry => entry.id === model) || !bodyParameters.has(paramName)) return false;
      return model !== argonModelId || !["temperature", "top_p"].includes(paramName);
    },
  },
  settingsSchema: [
    {
      key: "temperature", label: "Temperature", type: "range",
      min: 0, max: 2, step: 0.1, decimals: 1, capability: "temperature",
      modelBlocklist: [argonModelId],
    },
    {
      key: "topP", label: "Top P", type: "range",
      min: 0, max: 1, step: 0.05, decimals: 2, capability: "topP",
      modelBlocklist: [argonModelId],
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
  models,
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
