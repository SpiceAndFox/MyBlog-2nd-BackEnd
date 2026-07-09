const MODELS = [
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro" },
  { id: "mimo-v2.5", name: "MiMo-V2.5" },
];

const GLM_MODELS = ["glm-5.2", "glm-5.1"];
const DEEPSEEK_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
const THINKING_MODELS = [...GLM_MODELS, ...DEEPSEEK_MODELS];
const REASONING_EFFORT_MODELS = ["glm-5.2", ...DEEPSEEK_MODELS];
const WEB_SEARCH_MODELS = ["glm-5.2", "glm-5.1"];

const THINKING_MODE_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

const REASONING_EFFORT_OPTIONS = [
  { value: "max", label: "Max" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "minimal", label: "Minimal" },
  { value: "none", label: "None" },
];

const WEB_SEARCH_RECENCY_OPTIONS = [
  { value: "noLimit", label: "No limit" },
  { value: "oneDay", label: "One day" },
  { value: "oneWeek", label: "One week" },
  { value: "oneMonth", label: "One month" },
  { value: "oneYear", label: "One year" },
];

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function hasFiniteSetting(settings, key) {
  return Number.isFinite(Number(settings?.[key]));
}

function modelSupportsThinking(modelId) {
  return THINKING_MODELS.includes(normalizeModelId(modelId));
}

function modelSupportsReasoningEffort(modelId) {
  return REASONING_EFFORT_MODELS.includes(normalizeModelId(modelId));
}

function modelSupportsWebSearch(modelId) {
  return WEB_SEARCH_MODELS.includes(normalizeModelId(modelId));
}

function isDeepSeekModel(modelId) {
  return DEEPSEEK_MODELS.includes(normalizeModelId(modelId));
}

function normalizeThinkingMode(settings) {
  const raw = String(settings?.thinkingMode || "").trim();
  return raw === "disabled" ? "disabled" : "enabled";
}

function normalizeReasoningEffort(settings) {
  const raw = String(settings?.reasoningEffort || "").trim();
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === raw) ? raw : "max";
}

function normalizeDeepSeekReasoningEffort(settings) {
  const raw = String(settings?.reasoningEffort || "").trim();
  return raw === "high" ? "high" : "max";
}

function normalizeWebSearchRecency(settings) {
  const raw = String(settings?.webSearchRecency || "").trim();
  return WEB_SEARCH_RECENCY_OPTIONS.some((option) => option.value === raw) ? raw : "noLimit";
}

function buildWebSearchTool({ settings } = {}) {
  const count = Number(settings?.webSearchMaxResults);
  const normalizedCount = Number.isFinite(count) ? Math.min(50, Math.max(1, Math.trunc(count))) : 5;

  return {
    type: "web_search",
    web_search: {
      enable: "True",
      search_engine: "search-prime",
      search_result: "True",
      count: String(normalizedCount),
      search_recency_filter: normalizeWebSearchRecency(settings),
      content_size: "high",
    },
  };
}

function buildBodyExtensions({ model, settings } = {}) {
  const body = {};
  const modelId = normalizeModelId(model);
  const thinkingMode = normalizeThinkingMode(settings);

  if (modelSupportsThinking(modelId)) {
    body.thinking = { type: thinkingMode };
  }

  if (modelSupportsReasoningEffort(modelId) && thinkingMode === "enabled") {
    body.reasoning_effort = isDeepSeekModel(modelId)
      ? normalizeDeepSeekReasoningEffort(settings)
      : normalizeReasoningEffort(settings);
  }

  if (settings?.enableWebSearch && modelSupportsWebSearch(modelId)) {
    body.tools = [buildWebSearchTool({ settings })];
  }

  return body;
}

const THINKING_MODE_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsThinking(id));
const GLM_REASONING_EFFORT_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => id !== "glm-5.2");
const DEEPSEEK_REASONING_EFFORT_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !isDeepSeekModel(id));
const WEB_SEARCH_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsWebSearch(id));

module.exports = {
  id: "opencode-go-openai",
  name: "OpenCode Go (OpenAI-compatible)",
  adapter: "openai-compatible",
  apiKeyEnv: ["OPENCODE_API_KEY"],
  baseUrlEnv: ["OPENCODE_GO_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: buildBodyExtensions,
  },
  settingsSchema: [
    {
      key: "thinkingMode",
      label: "Thinking Mode",
      type: "select",
      options: THINKING_MODE_OPTIONS,
      default: "enabled",
      capability: "thinking",
      modelBlocklist: THINKING_MODE_BLOCKLIST,
    },
    {
      key: "reasoningEffort",
      label: "Reasoning Effort",
      type: "select",
      options: REASONING_EFFORT_OPTIONS,
      default: "max",
      capability: "thinking",
      modelBlocklist: GLM_REASONING_EFFORT_BLOCKLIST,
      disabledWhen: { key: "thinkingMode", value: "disabled" },
    },
    {
      key: "reasoningEffort",
      label: "Reasoning Effort",
      type: "select",
      options: REASONING_EFFORT_OPTIONS.filter((option) => option.value === "max" || option.value === "high"),
      default: "max",
      capability: "thinking",
      modelBlocklist: DEEPSEEK_REASONING_EFFORT_BLOCKLIST,
      disabledWhen: { key: "thinkingMode", value: "disabled" },
    },
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
    {
      key: "enableWebSearch",
      label: "Web Search (Z.AI)",
      type: "toggle",
      capability: "webSearch",
      modelBlocklist: WEB_SEARCH_BLOCKLIST,
    },
    {
      key: "webSearchMaxResults",
      label: "Web Search Max Results",
      type: "number",
      min: 1,
      max: 50,
      step: 1,
      default: 5,
      capability: "webSearch",
      modelBlocklist: WEB_SEARCH_BLOCKLIST,
    },
    {
      key: "webSearchRecency",
      label: "Web Search Recency",
      type: "select",
      options: WEB_SEARCH_RECENCY_OPTIONS,
      default: "noLimit",
      capability: "webSearch",
      modelBlocklist: WEB_SEARCH_BLOCKLIST,
    },
  ],
  models: MODELS,
  parameterPolicy: {
    blockedBodyParams: [
      "presence_penalty",
      "frequency_penalty",
      "tool_choice",
      "parallel_tool_calls",
    ],
    isBodyParamAllowed: ({ model, paramName, settings }) => {
      if (paramName === "presence_penalty" || paramName === "frequency_penalty") return false;
      if (paramName === "tool_choice" || paramName === "parallel_tool_calls") return false;
      if (paramName === "thinking") return modelSupportsThinking(model);
      if (paramName === "reasoning_effort") {
        return modelSupportsReasoningEffort(model) && normalizeThinkingMode(settings) === "enabled";
      }
      if (isDeepSeekModel(model) && normalizeThinkingMode(settings) === "enabled") {
        if (paramName === "temperature" || paramName === "top_p") return false;
        if (paramName === "logprobs" || paramName === "top_logprobs") return false;
      }
      if (paramName === "top_p" && hasFiniteSetting(settings, "temperature")) return false;
      if (paramName === "tools") return Boolean(settings?.enableWebSearch) && modelSupportsWebSearch(model);
      return true;
    },
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
    thinking: true,
  },
};
