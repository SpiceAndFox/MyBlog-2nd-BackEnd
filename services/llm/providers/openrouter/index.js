const { buildOpenRouterAttributionHeaders } = require("./headers");

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

const GLM_5_2_MODEL_ID = "z-ai/glm-5.2";
const GROK_4_5_MODEL_ID = "x-ai/grok-4.5";
const PRESENCE_PENALTY_PARAM = "presence_penalty";
const FREQUENCY_PENALTY_PARAM = "frequency_penalty";

const reasoningEffortOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

function isReasoningEnabled(settings) {
  return settings?.reasoningEnabled !== false;
}

function normalizeReasoningEffort(settings, modelId) {
  const raw = String(settings?.reasoningEffort || "").trim().toLowerCase();
  const supported = getModel(modelId)?.reasoningEfforts;
  if (!Array.isArray(supported) || !supported.length) return "";
  if (!raw) return "";
  if (!supported.includes(raw)) {
    throw new Error(
      `Invalid reasoningEffort for model ${normalizeModelId(modelId)}: ${raw}. Allowed values: ${supported.join(", ")}`
    );
  }
  return raw;
}

function buildWebSearchToolConfig({ settings } = {}) {
  const maxResults = Number(settings?.webSearchMaxResults);

  const tool = {
    type: "openrouter:web_search",
    parameters: {
      engine: "exa",
    },
  };

  if (Number.isFinite(maxResults)) {
    const normalized = Math.trunc(maxResults);
    if (normalized > 0 && normalized <= 10) tool.parameters.max_results = normalized;
  }

  return tool;
}

function buildBodyExtensions({ model, settings } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};

  const body = {};
  const modelId = normalizeModelId(model);

  const enableWebSearch = Boolean(settings.enableWebSearch);
  if (enableWebSearch) {
    body.tools = [buildWebSearchToolConfig({ settings })];
  }

  if (modelId === GLM_5_2_MODEL_ID) {
    if (!isReasoningEnabled(settings)) {
      body.reasoning = {
        enabled: false,
        exclude: true,
      };
    } else {
      const effort = normalizeReasoningEffort(settings, modelId);
      if (effort) {
        body.reasoning = {
          effort,
          exclude: true,
        };
      }
    }
  } else if (modelId === GROK_4_5_MODEL_ID) {
    // grok-4.5 reasoning is mandatory and cannot be disabled;
    // only forward the effort when set.
    const effort = normalizeReasoningEffort(settings, modelId);
    if (effort) {
      body.reasoning = {
        effort,
        exclude: true,
      };
    }
  }

  return body;
}

const MODELS = [
  {
    id: GLM_5_2_MODEL_ID,
    name: GLM_5_2_MODEL_ID,
    supportedParameters: [FREQUENCY_PENALTY_PARAM, PRESENCE_PENALTY_PARAM],
    reasoningEfforts: ["xhigh", "high"],
    canDisableReasoning: true,
    defaults: { reasoningEnabled: false, reasoningEffort: "xhigh", temperature: 0.75, topP: 0.95 },
  },
  {
    id: GROK_4_5_MODEL_ID,
    name: GROK_4_5_MODEL_ID,
    supportedParameters: [],
    reasoningEfforts: ["high", "medium", "low"],
    canDisableReasoning: false,
    defaults: { reasoningEffort: "low" },
  },
];

const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]));

function getModel(modelId) {
  return MODEL_BY_ID.get(normalizeModelId(modelId)) || null;
}

function modelSupportsParameter(modelId, paramName) {
  const model = getModel(modelId);
  if (!model) return false;
  return Array.isArray(model.supportedParameters) && model.supportedParameters.includes(paramName);
}

function modelSupportsReasoningEffort(modelId) {
  const model = getModel(modelId);
  return Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length > 0;
}

function modelCanDisableReasoning(modelId) {
  const model = getModel(modelId);
  return Boolean(model?.canDisableReasoning);
}

const PRESENCE_PENALTY_BLOCKLIST = MODELS.map((model) => model.id).filter(
  (id) => !modelSupportsParameter(id, PRESENCE_PENALTY_PARAM)
);
const FREQUENCY_PENALTY_BLOCKLIST = MODELS.map((model) => model.id).filter(
  (id) => !modelSupportsParameter(id, FREQUENCY_PENALTY_PARAM)
);
const REASONING_EFFORT_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelSupportsReasoningEffort(id));
const REASONING_DISABLE_BLOCKLIST = MODELS.map((model) => model.id).filter((id) => !modelCanDisableReasoning(id));

module.exports = {
  id: "openrouter",
  name: "OpenRouter",
  adapter: "openai-compatible",
  apiKeyEnv: ["OPENROUTER_API_KEY"],
  baseUrlEnv: ["OPENROUTER_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: buildBodyExtensions,
    headers: () => buildOpenRouterAttributionHeaders(),
  },
  settingsSchema: [
    {
      key: "maxOutputTokens",
      label: "Max Tokens",
      type: "number",
      min: 128,
      max: 24000,
      step: 64,
      capability: "maxTokens",
    },
    {
      key: "webSearchMaxResults",
      label: "Web Search Max Results (1-10)",
      type: "number",
      min: 1,
      max: 10,
      step: 1,
      default: 5,
      capability: "webSearch",
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
      key: "reasoningEnabled",
      label: "Enable Reasoning",
      type: "toggle",
      default: false,
      capability: "thinking",
      modelBlocklist: REASONING_DISABLE_BLOCKLIST,
    },
    {
      key: "reasoningEffort",
      label: "Reasoning Effort",
      type: "select",
      options: reasoningEffortOptions,
      optionsFrom: "reasoningEfforts",
      default: "xhigh",
      capability: "thinking",
      modelBlocklist: REASONING_EFFORT_BLOCKLIST,
      disabledWhen: { key: "reasoningEnabled", value: false, modelBlocklist: REASONING_DISABLE_BLOCKLIST },
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
      modelBlocklist: PRESENCE_PENALTY_BLOCKLIST,
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
      modelBlocklist: FREQUENCY_PENALTY_BLOCKLIST,
    },
    {
      key: "enableWebSearch",
      label: "Web Search (OpenRouter: Exa)",
      type: "toggle",
      capability: "webSearch",
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
    blockedBodyParams: [],
    isBodyParamAllowed: ({ model, paramName }) => {
      if (paramName === PRESENCE_PENALTY_PARAM || paramName === FREQUENCY_PENALTY_PARAM) {
        return modelSupportsParameter(model, paramName);
      }

      return true;
    },
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    presencePenalty: true,
    frequencyPenalty: true,
    maxTokens: true,
    webSearch: true,
    tools: false,
    thinking: true,
  },
};
