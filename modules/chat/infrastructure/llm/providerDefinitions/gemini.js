const safetyThresholdOptions = [
  { value: "HARM_BLOCK_THRESHOLD_UNSPECIFIED", label: "Default" },
  { value: "OFF", label: "Off (disable filter)" },
  { value: "BLOCK_NONE", label: "Block none" },
  { value: "BLOCK_ONLY_HIGH", label: "Block only high" },
  { value: "BLOCK_MEDIUM_AND_ABOVE", label: "Block medium and above" },
  { value: "BLOCK_LOW_AND_ABOVE", label: "Block low and above" },
];

const thinkingLevelOptions = [
  { value: "MINIMAL", label: "Minimal" },
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High (default)" },
];

const thinkingLevelProOptions = thinkingLevelOptions.filter((option) =>
  ["LOW", "MEDIUM", "HIGH"].includes(option.value),
);
// Official model specs and migration rules (checked 2026-09-12):
// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
// https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
// https://ai.google.dev/gemini-api/docs/thinking
// https://ai.google.dev/gemini-api/docs/latest-model

module.exports = {
  id: "gemini",
  name: "Gemini (Google)",
  adapter: "google-genai",
  apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  baseUrlEnv: ["GEMINI_BASE_URL"],
  parameterPolicy: {
    blockedBodyParams: [],
    isBodyParamAllowed: ({ model, paramName, settings }) => {
      const normalizedModel = String(model || "").trim();
      if (["presencePenalty", "frequencyPenalty", "thinkingBudget"].includes(paramName)) return false;
      if (["gemini-3.8-flash", "gemini-3.7-flash"].includes(normalizedModel)) {
        if (["temperature", "topP", "topK", "candidateCount"].includes(paramName)) return false;
        if (paramName === "thinkingLevel") {
          return ["LOW", "MEDIUM", "HIGH"].includes(
            String(settings?.thinkingLevel || "")
              .trim()
              .toUpperCase(),
          );
        }
      }

      if (paramName === "thinkingLevel") {
        return normalizedModel.startsWith("gemini-3");
      }

      return true;
    },
  },
  settingsSchema: [
    {
      key: "temperature",
      label: "Temperature",
      type: "range",
      min: 0,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "temperature",
      modelBlocklist: ["gemini-3.8-flash", "gemini-3.7-flash"],
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
      modelBlocklist: ["gemini-3.8-flash", "gemini-3.7-flash"],
    },
    {
      key: "maxOutputTokens",
      label: "Max Output Tokens",
      type: "number",
      min: 128,
      max: 24000,
      step: 64,
      capability: "maxTokens",
      modelBlocklist: ["gemini-3.8-flash", "gemini-3.7-flash"],
    },
    {
      key: "maxOutputTokens",
      label: "Max Output Tokens",
      type: "number",
      min: 1,
      max: 65536,
      step: 1,
      capability: "maxTokens",
      modelBlocklist: ["gemini-3-flash-preview", "gemini-3.1-pro-preview"],
    },
    {
      key: "thinkingLevel",
      label: "Thinking Level",
      type: "select",
      options: [
        { value: "LOW", label: "Low" },
        { value: "MEDIUM", label: "Medium (default)" },
        { value: "HIGH", label: "High" },
      ],
      default: "MEDIUM",
      capability: "thinking",
      modelBlocklist: ["gemini-3-flash-preview", "gemini-3.1-pro-preview"],
    },
    {
      key: "thinkingLevel",
      label: "Thinking Level",
      type: "select",
      options: thinkingLevelProOptions,
      default: "HIGH",
      capability: "thinking",
      modelBlocklist: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3-flash-preview"],
    },
    {
      key: "thinkingLevel",
      label: "Thinking Level",
      type: "select",
      options: thinkingLevelOptions,
      default: "MINIMAL",
      capability: "thinking",
      modelBlocklist: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview"],
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
    {
      key: "enableWebSearch",
      label: "Web Search (Google)",
      type: "toggle",
      capability: "webSearch",
    },
    {
      key: "safetyHarassment",
      label: "Safety: Harassment",
      type: "select",
      options: safetyThresholdOptions,
      default: "OFF",
    },
    {
      key: "safetyHateSpeech",
      label: "Safety: Hate speech",
      type: "select",
      options: safetyThresholdOptions,
      default: "OFF",
    },
    {
      key: "safetySexuallyExplicit",
      label: "Safety: Sexually explicit",
      type: "select",
      options: safetyThresholdOptions,
      default: "OFF",
    },
    {
      key: "safetyDangerousContent",
      label: "Safety: Dangerous content",
      type: "select",
      options: safetyThresholdOptions,
      default: "OFF",
    },
  ],
  models: [
    { id: "gemini-3.8-flash", name: "gemini-3.8-flash", defaults: { thinkingLevel: "MEDIUM" } },
    { id: "gemini-3.7-flash", name: "gemini-3.7-flash", defaults: { thinkingLevel: "MEDIUM" } },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
  ],
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: false,
    frequencyPenalty: false,
    webSearch: true,
    tools: false,
    thinking: true,
  },
};
