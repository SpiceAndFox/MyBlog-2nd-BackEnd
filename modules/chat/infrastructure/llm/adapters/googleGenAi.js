const { GoogleGenAI } = require("@google/genai");

function createGoogleGenAiAdapter({ providers, settingsSchema, config: llmConfig, GoogleGenAIClass = GoogleGenAI } = {}) {
  if (!providers?.getProviderConfig || !providers?.isBodyParamAllowed) {
    throw new Error("Google GenAI adapter requires a provider registry");
  }
  if (!settingsSchema?.getGlobalNumericRange || !settingsSchema?.getProviderNumericRange || !settingsSchema?.clampNumberWithRange) {
    throw new Error("Google GenAI adapter requires a settings schema");
  }
  if (!Number.isFinite(llmConfig?.timeoutMs) || llmConfig.timeoutMs <= 0) throw new Error("Google GenAI adapter timeout is required");
  if (typeof GoogleGenAIClass !== "function") throw new Error("Google GenAI client constructor is required");
  const { getProviderConfig, isBodyParamAllowed } = providers;
  const { clampNumberWithRange, getGlobalNumericRange, getProviderNumericRange } = settingsSchema;

const SUPPORTED_HARM_BLOCK_THRESHOLDS = new Set([
  "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
  "OFF",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
]);

const SAFETY_THRESHOLD_KEYS = [
  { key: "safetyHarassment", category: "HARM_CATEGORY_HARASSMENT" },
  { key: "safetyHateSpeech", category: "HARM_CATEGORY_HATE_SPEECH" },
  { key: "safetySexuallyExplicit", category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" },
  { key: "safetyDangerousContent", category: "HARM_CATEGORY_DANGEROUS_CONTENT" },
];

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeText(value) {
  return String(value || "");
}

function applyGroundingCitations(text, groundingMetadata) {
  const rawText = typeof text === "string" ? text : "";
  if (!rawText) return rawText;

  const supports = groundingMetadata?.groundingSupports;
  const chunks = groundingMetadata?.groundingChunks;
  if (!Array.isArray(supports) || !Array.isArray(chunks) || !supports.length || !chunks.length) return rawText;

  const sortedSupports = [...supports].sort((a, b) => (b?.segment?.endIndex ?? 0) - (a?.segment?.endIndex ?? 0));

  let output = rawText;
  for (const support of sortedSupports) {
    const endIndex = support?.segment?.endIndex;
    if (!Number.isFinite(endIndex) || endIndex < 0) continue;
    if (!Array.isArray(support?.groundingChunkIndices) || !support.groundingChunkIndices.length) continue;
    if (endIndex > output.length) continue;

    const links = support.groundingChunkIndices
      .map((index) => {
        const chunk = chunks[index];
        const uri = typeof chunk?.web?.uri === "string" ? chunk.web.uri.trim() : "";
        if (!uri) return null;
        return `[${index + 1}](${uri})`;
      })
      .filter(Boolean);

    if (!links.length) continue;

    output = `${output.slice(0, endIndex)}${links.join(", ")}${output.slice(endIndex)}`;
  }

  return output;
}

function readSetting(settings, key) {
  if (!isPlainObject(settings)) return undefined;
  return settings[key];
}

function clampConfigNumber(providerId, key, value, { integer } = {}) {
  const range = getProviderNumericRange(providerId, key) || getGlobalNumericRange(key);
  const nextValue = clampNumberWithRange(value, range);
  if (!Number.isFinite(nextValue)) return null;
  return integer ? Math.trunc(nextValue) : nextValue;
}

function mergeRawGenerateContentConfig({ providerId, model, settings, config, rawConfig }) {
  if (!isPlainObject(config)) return config;
  if (!isPlainObject(rawConfig) || Object.keys(rawConfig).length === 0) return config;

  const protectedKeys = new Set(["abortSignal", "httpOptions", "systemInstruction"]);
  const schemaKeys = new Set([
    "temperature",
    "topP",
    "maxOutputTokens",
    "presencePenalty",
    "frequencyPenalty",
    "thinkingConfig",
    "safetySettings",
    "tools",
  ]);

  for (const [key, value] of Object.entries(rawConfig)) {
    const paramName = String(key || "").trim();
    if (!paramName) continue;
    if (value === undefined) continue;
    if (protectedKeys.has(paramName)) continue;
    if (schemaKeys.has(paramName)) continue;
    if (!isBodyParamAllowed(providerId, paramName, { model, settings })) continue;
    config[paramName] = value;
  }

  return config;
}

function buildSafetySettings(settings) {
  if (!isPlainObject(settings)) return [];

  const output = [];
  for (const entry of SAFETY_THRESHOLD_KEYS) {
    const threshold = typeof settings[entry.key] === "string" ? settings[entry.key].trim() : "";
    if (!threshold) continue;
    if (!SUPPORTED_HARM_BLOCK_THRESHOLDS.has(threshold)) continue;
    if (threshold === "HARM_BLOCK_THRESHOLD_UNSPECIFIED") continue;
    output.push({ category: entry.category, threshold });
  }
  return output;
}

function buildContentsFromOpenAiMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const contents = [];
  const systemParts = [];

  for (const message of list) {
    const role = String(message?.role || "").trim();
    const content = normalizeText(message?.content).trim();
    if (!role || !content) continue;

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    const geminiRole = role === "user" ? "user" : role === "assistant" ? "model" : "";
    if (!geminiRole) continue;
    contents.push({ role: geminiRole, parts: [{ text: content }] });
  }

  const systemInstruction = systemParts.join("\n\n").trim();
  return { contents, systemInstruction };
}

function buildGenerateContentConfig({
  providerId,
  model,
  baseUrl,
  systemInstruction,
  timeoutMs,
  signal,
  settings,
  rawConfig,
} = {}) {
  const config = {};

  if (signal) config.abortSignal = signal;

  const httpOptions = {};
  if (typeof baseUrl === "string" && baseUrl.trim()) httpOptions.baseUrl = baseUrl.trim();
  if (Number.isFinite(Number(timeoutMs))) httpOptions.timeout = Number(timeoutMs);
  if (Object.keys(httpOptions).length) config.httpOptions = httpOptions;

  if (systemInstruction) config.systemInstruction = systemInstruction;

  const temperature = readSetting(settings, "temperature");
  const topP = readSetting(settings, "topP");
  const maxOutputTokens = readSetting(settings, "maxOutputTokens");
  const presencePenalty = readSetting(settings, "presencePenalty");
  const frequencyPenalty = readSetting(settings, "frequencyPenalty");
  const enableWebSearch = Boolean(readSetting(settings, "enableWebSearch"));
  const thinkingLevel = readSetting(settings, "thinkingLevel");
  const thinkingBudget = readSetting(settings, "thinkingBudget");

  const normalizedTemperature = clampConfigNumber(providerId, "temperature", temperature);
  const normalizedTopP = clampConfigNumber(providerId, "topP", topP);
  const normalizedMaxTokens = clampConfigNumber(providerId, "maxOutputTokens", maxOutputTokens, { integer: true });
  const normalizedPresencePenalty = clampConfigNumber(providerId, "presencePenalty", presencePenalty);
  const normalizedFrequencyPenalty = clampConfigNumber(providerId, "frequencyPenalty", frequencyPenalty);
  const normalizedThinkingBudget = clampConfigNumber(providerId, "thinkingBudget", thinkingBudget, { integer: true });

  if (normalizedTemperature !== null && isBodyParamAllowed(providerId, "temperature", { model, settings })) {
    config.temperature = normalizedTemperature;
  }
  if (normalizedTopP !== null && isBodyParamAllowed(providerId, "topP", { model, settings })) {
    config.topP = normalizedTopP;
  }
  if (normalizedMaxTokens !== null && isBodyParamAllowed(providerId, "maxOutputTokens", { model, settings })) {
    config.maxOutputTokens = normalizedMaxTokens;
  }
  if (normalizedPresencePenalty !== null && isBodyParamAllowed(providerId, "presencePenalty", { model, settings })) {
    config.presencePenalty = normalizedPresencePenalty;
  }
  if (normalizedFrequencyPenalty !== null && isBodyParamAllowed(providerId, "frequencyPenalty", { model, settings })) {
    config.frequencyPenalty = normalizedFrequencyPenalty;
  }

  const thinkingConfig = {};

  if (typeof thinkingLevel === "string") {
    const normalizedThinkingLevel = thinkingLevel.trim().toUpperCase();
    if (
      ["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(normalizedThinkingLevel) &&
      isBodyParamAllowed(providerId, "thinkingLevel", { model, settings })
    ) {
      thinkingConfig.thinkingLevel = normalizedThinkingLevel;
    }
  }

  if (normalizedThinkingBudget !== null && isBodyParamAllowed(providerId, "thinkingBudget", { model, settings })) {
    thinkingConfig.thinkingBudget = normalizedThinkingBudget;
  }

  if (Object.keys(thinkingConfig).length) {
    config.thinkingConfig = thinkingConfig;
  }

  const safetySettings = buildSafetySettings(settings);
  if (safetySettings.length) config.safetySettings = safetySettings;

  if (enableWebSearch && isBodyParamAllowed(providerId, "tools", { model, settings })) {
    config.tools = [{ googleSearch: {} }];
  }

  mergeRawGenerateContentConfig({ providerId, model, settings, config, rawConfig });

  return config;
}

function ensureAbortSignal(timeoutMs, parentSignal) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortController.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", () => abortController.abort(parentSignal.reason), { once: true });
    }
  }

  return { signal: abortController.signal, cleanup: () => clearTimeout(timeout) };
}

function pickFunctionCallNames(functionCalls) {
  const calls = Array.isArray(functionCalls) ? functionCalls : [];
  return calls
    .map((call) => call?.name)
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
}

async function createChatCompletion({
  providerId,
  model,
  messages,
  timeoutMs = llmConfig.timeoutMs,
  signal,
  settings,
  rawConfig,
} = {}) {
  const provider = getProviderConfig(providerId);
  const ai = new GoogleGenAIClass({ apiKey: provider.apiKey });

  const { signal: abortSignal, cleanup } = ensureAbortSignal(timeoutMs, signal);

  try {
    const { contents, systemInstruction } = buildContentsFromOpenAiMessages(messages);
    const config = buildGenerateContentConfig({
      providerId: provider.id,
      model,
      baseUrl: provider.baseUrl,
      systemInstruction,
      timeoutMs,
      signal: abortSignal,
      settings,
      rawConfig,
    });

    const response = await ai.models.generateContent({ model, contents, config });

    const functionCalls = response?.functionCalls;
    if (Array.isArray(functionCalls) && functionCalls.length) {
      const names = pickFunctionCallNames(functionCalls);
      throw new Error(
        `Model requested function calls (${names || functionCalls.length}), but tool calls are not implemented yet.`
      );
    }

    const groundingMetadata = response?.candidates?.[0]?.groundingMetadata;

    const rawText = normalizeText(response?.text);
    const content = applyGroundingCitations(rawText, groundingMetadata).trim();
    if (!content) {
      const blockReason = response?.promptFeedback?.blockReason || response?.promptFeedback?.blockReasonMessage;
      if (blockReason) throw new Error(`Blocked by safety policy: ${String(blockReason)}`);
      throw new Error("Empty model response");
    }

    return { content, raw: response };
  } finally {
    cleanup();
  }
}

async function createChatCompletionStreamResponse({ providerId, model, messages, signal, settings, rawConfig } = {}) {
  const provider = getProviderConfig(providerId);
  const ai = new GoogleGenAIClass({ apiKey: provider.apiKey });

  const { contents, systemInstruction } = buildContentsFromOpenAiMessages(messages);
  const config = buildGenerateContentConfig({
    providerId: provider.id,
    model,
    baseUrl: provider.baseUrl,
    systemInstruction,
    timeoutMs: llmConfig.timeoutMs,
    signal,
    settings,
    rawConfig,
  });

  return ai.models.generateContentStream({ model, contents, config });
}

async function* streamChatCompletionDeltas({ response }) {
  let emitted = "";
  let groundingMetadata = null;

  for await (const chunk of response) {
    const functionCalls = chunk?.functionCalls;
    if (Array.isArray(functionCalls) && functionCalls.length) {
      const names = pickFunctionCallNames(functionCalls);
      throw new Error(
        `Model requested function calls (${names || functionCalls.length}), but tool calls are not implemented yet.`
      );
    }

    const blockReason = chunk?.promptFeedback?.blockReason || chunk?.promptFeedback?.blockReasonMessage;
    if (blockReason) throw new Error(`Blocked by safety policy: ${String(blockReason)}`);

    const nextGroundingMetadata = chunk?.candidates?.[0]?.groundingMetadata;
    if (nextGroundingMetadata) groundingMetadata = nextGroundingMetadata;

    const text = typeof chunk?.text === "string" ? chunk.text : "";
    if (!text) continue;

    if (text.startsWith(emitted)) {
      const delta = text.slice(emitted.length);
      emitted = text;
      if (delta) yield { type: "delta", delta };
      continue;
    }

    emitted += text;
    yield { type: "delta", delta: text };
  }

  if (groundingMetadata) {
    const content = applyGroundingCitations(emitted, groundingMetadata).trim() || emitted.trim();
    yield { type: "final", content };
  }
}

return Object.freeze({
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
});
}

module.exports = { createGoogleGenAiAdapter };
