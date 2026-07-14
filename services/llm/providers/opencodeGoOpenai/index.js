// 能力与约束全部声明在 MODELS 数组的模型属性上，
// 通过 MODEL_BY_ID 做 O(1) 查询，派生 blocklist 统一从属性计算。
// 新增模型只需在 MODELS 加一条并填好属性，无需改动并行数组或分支逻辑。

const MODELS = [
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    supportsThinking: true,
    reasoningEfforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    supportsWebSearch: true,
    webSearchFormat: "glm",
    defaults: { temperature: 0.75, topP: 0.95 },
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    supportsThinking: true,
    supportsWebSearch: true,
    webSearchFormat: "glm",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    supportsThinking: true,
    reasoningEfforts: ["max", "high"],
    // DeepSeek 思考开启时禁止采样/对数概率参数（上游 API 约束）
    blocksSamplingWhenThinking: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    supportsThinking: true,
    reasoningEfforts: ["max", "high"],
    blocksSamplingWhenThinking: true,
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    supportsThinking: true,
    // MiMo 启用思考时强制 temperature=1.0 / top_p=0.95，采样参数被忽略（同 DeepSeek）。
    // 屏蔽采样参数以发送干净请求，避免发送会被忽略的值。
    blocksSamplingWhenThinking: true,
    // 不声明 reasoningEfforts：MiMo 原生不支持 reasoning_effort 参数。
    supportsWebSearch: true,
    // MiMo 原生 web search 为扁平格式（max_keyword/force_search/limit），
    // 与 GLM 嵌套格式不兼容；通过 webSearchFormat 让 builder 按模型分发正确格式。
    webSearchFormat: "mimo",
    // 官方建议采样参数：temperature=1.0、top_p=0.95。
    // 思考开启时上游会强制这两个值；此处设为默认值，思考关闭时也用官方建议值起步。
    defaults: { temperature: 1.0, topP: 0.95 },
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    supportsWebSearch: true,
    webSearchFormat: "mimo",
    defaults: { temperature: 1.0, topP: 0.95 },
  },
];

const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]));

const THINKING_MODE_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

// reasoning effort 的全集；每个模型通过 reasoningEfforts 属性声明自己支持的子集，
// 前端经 optionsFrom: "reasoningEfforts" 自动裁剪。
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

function getModel(modelId) {
  return MODEL_BY_ID.get(normalizeModelId(modelId)) || null;
}

function hasFiniteSetting(settings, key) {
  return Number.isFinite(Number(settings?.[key]));
}

function modelSupportsThinking(modelId) {
  return Boolean(getModel(modelId)?.supportsThinking);
}

function modelSupportsReasoningEffort(modelId) {
  const model = getModel(modelId);
  return Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length > 0;
}

function modelSupportsWebSearch(modelId) {
  return Boolean(getModel(modelId)?.supportsWebSearch);
}

function getModelWebSearchFormat(modelId) {
  return String(getModel(modelId)?.webSearchFormat || "").trim() || null;
}

function modelUsesGlmWebSearchFormat(modelId) {
  return getModelWebSearchFormat(modelId) === "glm";
}

function modelUsesMimoWebSearchFormat(modelId) {
  return getModelWebSearchFormat(modelId) === "mimo";
}

function modelBlocksSamplingWhenThinking(modelId) {
  return Boolean(getModel(modelId)?.blocksSamplingWhenThinking);
}

function normalizeThinkingMode(settings) {
  const raw = String(settings?.thinkingMode || "").trim();
  return raw === "disabled" ? "disabled" : "enabled";
}

function normalizeReasoningEffort(settings, modelId) {
  const raw = String(settings?.reasoningEffort || "").trim();
  const model = getModel(modelId);
  const allowed = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : [];
  if (!allowed.length) {
    throw new Error(`Model does not support reasoning effort: ${normalizeModelId(modelId) || "(empty)"}`);
  }
  if (!raw) return allowed.includes("max") ? "max" : allowed[0];
  if (!allowed.includes(raw)) {
    throw new Error(
      `Invalid reasoningEffort for model ${normalizeModelId(modelId)}: ${raw}. Allowed values: ${allowed.join(", ")}`,
    );
  }
  return raw;
}

function normalizeWebSearchRecency(settings) {
  const raw = String(settings?.webSearchRecency || "").trim();
  return WEB_SEARCH_RECENCY_OPTIONS.some((option) => option.value === raw) ? raw : "noLimit";
}

function buildGlmWebSearchTool({ settings } = {}) {
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

function buildMiMoWebSearchTool({ settings } = {}) {
  const limit = Number(settings?.webSearchMaxResults);
  const normalizedLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 5;

  const maxKeyword = Number(settings?.webSearchMaxKeyword);
  const normalizedMaxKeyword = Number.isFinite(maxKeyword) ? Math.min(10, Math.max(1, Math.trunc(maxKeyword))) : 3;

  return {
    type: "web_search",
    max_keyword: normalizedMaxKeyword,
    force_search: Boolean(settings?.webSearchForceSearch),
    limit: normalizedLimit,
  };
}

function buildWebSearchTool({ model, settings } = {}) {
  const modelId = normalizeModelId(model);
  if (modelUsesMimoWebSearchFormat(modelId)) return buildMiMoWebSearchTool({ settings });
  return buildGlmWebSearchTool({ settings });
}

function buildBodyExtensions({ model, settings } = {}) {
  const body = {};
  const modelId = normalizeModelId(model);
  const thinkingMode = normalizeThinkingMode(settings);
  const supportsThinking = modelSupportsThinking(modelId);
  const supportsReasoningEffort = modelSupportsReasoningEffort(modelId);

  // OpenCode Go 网关拒绝同时携带 `thinking` 和 `reasoning_effort`（官方 GLM API 允许，但网关不允许）。
  // 因此两者互斥：
  //   - thinking enabled + 模型支持 reasoning_effort → 只发 reasoning_effort（网关据此推断思考开启）
  //   - thinking enabled + 模型不支持 reasoning_effort → 只发 thinking: { type: "enabled" }
  //   - thinking disabled → 只发 thinking: { type: "disabled" }，不发 reasoning_effort
  if (thinkingMode === "enabled") {
    if (supportsReasoningEffort) {
      body.reasoning_effort = normalizeReasoningEffort(settings, modelId);
    } else if (supportsThinking) {
      body.thinking = { type: "enabled" };
    }
  } else if (supportsThinking) {
    body.thinking = { type: "disabled" };
  }

  if (settings?.enableWebSearch && modelSupportsWebSearch(modelId)) {
    body.tools = [buildWebSearchTool({ model: modelId, settings })];
  }

  return body;
}

// 派生 blocklist：从模型属性计算，与 openrouter 模式一致。
const THINKING_MODE_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsThinking(id));
const REASONING_EFFORT_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsReasoningEffort(id));
const WEB_SEARCH_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsWebSearch(id));
// webSearchRecency 为 GLM 专属（search_recency_filter），对非 GLM 格式模型隐藏。
const GLM_WEB_SEARCH_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelUsesGlmWebSearchFormat(id));
// MiMo 专属旋钮（force_search / max_keyword）仅对 MiMo 格式模型可见。
const MIMO_WEB_SEARCH_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelUsesMimoWebSearchFormat(id));

module.exports = {
  id: "opencode-go-openai",
  name: "OpenCode Go (OpenAI-compatible)",
  adapter: "openai-compatible",
  apiKeyEnv: ["OPENCODE_GO_API_KEY"],
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
      optionsFrom: "reasoningEfforts",
      default: "max",
      capability: "thinking",
      modelBlocklist: REASONING_EFFORT_BLOCKLIST,
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
      label: "Web Search",
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
      modelBlocklist: GLM_WEB_SEARCH_BLOCKLIST,
    },
    {
      key: "webSearchForceSearch",
      label: "Web Search: Force Search",
      type: "toggle",
      default: false,
      capability: "webSearch",
      modelBlocklist: MIMO_WEB_SEARCH_BLOCKLIST,
    },
    {
      key: "webSearchMaxKeyword",
      label: "Web Search: Max Keywords",
      type: "number",
      min: 1,
      max: 10,
      step: 1,
      default: 3,
      capability: "webSearch",
      modelBlocklist: MIMO_WEB_SEARCH_BLOCKLIST,
    },
  ],
  models: MODELS,
  parameterPolicy: {
    blockedBodyParams: ["presence_penalty", "frequency_penalty", "tool_choice", "parallel_tool_calls"],
    isBodyParamAllowed: ({ model, paramName, settings }) => {
      if (paramName === "presence_penalty" || paramName === "frequency_penalty") return false;
      if (paramName === "tool_choice" || paramName === "parallel_tool_calls") return false;
      // thinking 与 reasoning_effort 互斥（网关约束），与 buildBodyExtensions 逻辑一致：
      //   - thinking enabled + 支持 reasoning_effort → 只允许 reasoning_effort，不允许 thinking
      //   - thinking disabled / 不支持 reasoning_effort → 只允许 thinking，不允许 reasoning_effort
      if (paramName === "thinking") {
        return (
          modelSupportsThinking(model) &&
          !(normalizeThinkingMode(settings) === "enabled" && modelSupportsReasoningEffort(model))
        );
      }
      if (paramName === "reasoning_effort") {
        return modelSupportsReasoningEffort(model) && normalizeThinkingMode(settings) === "enabled";
      }
      if (modelBlocksSamplingWhenThinking(model) && normalizeThinkingMode(settings) === "enabled") {
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
