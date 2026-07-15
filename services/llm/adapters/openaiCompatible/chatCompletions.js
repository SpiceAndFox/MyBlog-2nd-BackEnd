const { getProviderConfig, getProviderDefinition, isBodyParamAllowed } = require("../../providers");
const { llmConfig } = require("../../../../config");
const { getGlobalNumericRange, getProviderNumericRange, clampNumberWithRange } = require("../../settingsSchema");

function normalizeBaseUrl(baseUrl) {
  const url = new URL(String(baseUrl || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = String(path || "")
    .trim()
    .replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBaseUrl).toString();
}

function clampBodyNumber(providerId, key, value, { integer } = {}) {
  const range = getProviderNumericRange(providerId, key) || getGlobalNumericRange(key);
  const nextValue = clampNumberWithRange(value, range);
  if (!Number.isFinite(nextValue)) return null;
  return integer ? Math.trunc(nextValue) : nextValue;
}

function normalizeText(value) {
  return String(value || "");
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function pickErrorMessage({ status, json, text }) {
  if (json && typeof json === "object") {
    const message =
      json?.error?.message ||
      json?.error ||
      json?.message ||
      json?.msg ||
      (typeof json?.detail === "string" ? json.detail : null);
    if (message) return String(message);
  }
  if (text) return text.slice(0, 800);
  return `Upstream LLM request failed (HTTP ${status})`;
}

function readSetting(settings, key) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return settings[key];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// openrouter
function buildHeaderExtensions({ providerId, model, settings }) {
  const definition = getProviderDefinition(providerId);
  const extensions = definition?.openaiCompatible?.headers;

  let raw = {};
  if (typeof extensions === "function") {
    const value = extensions({ model, settings: settings || {} });
    raw = isPlainObject(value) ? value : {};
  } else if (isPlainObject(extensions)) {
    raw = extensions;
  }

  const headers = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || "").trim();
    if (!name) continue;
    if (value === undefined || value === null) continue;
    const normalizedValue = typeof value === "string" ? value.trim() : String(value);
    if (!normalizedValue) continue;
    headers[name] = normalizedValue;
  }

  return headers;
}

function buildBodyExtensions({ providerId, model, settings }) {
  const definition = getProviderDefinition(providerId);
  const extensions = definition?.openaiCompatible?.bodyExtensions;

  if (typeof extensions === "function") {
    const value = extensions({ model, settings: settings || {} });
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    return {};
  }

  if (extensions && typeof extensions === "object" && !Array.isArray(extensions)) {
    return extensions;
  }

  return {};
}

function mergeRawBodyParams({ providerId, model, settings, body, rawBody }) {
  if (!isPlainObject(body)) return body;
  if (!isPlainObject(rawBody) || Object.keys(rawBody).length === 0) return body;

  const protectedKeys = new Set(["model", "messages", "stream"]);
  const schemaKeys = new Set(["temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty"]);

  for (const [key, value] of Object.entries(rawBody)) {
    const paramName = String(key || "").trim();
    if (!paramName) continue;
    if (value === undefined) continue;
    if (protectedKeys.has(paramName)) continue;
    if (schemaKeys.has(paramName)) continue;
    if (Object.prototype.hasOwnProperty.call(body, paramName)) continue;
    if (!isBodyParamAllowed(providerId, paramName, { model, settings })) continue;
    body[paramName] = value;
  }

  return body;
}

function buildBody({
  providerId,
  model,
  messages,
  temperature,
  topP,
  maxTokens,
  presencePenalty,
  frequencyPenalty,
  stream,
  settings,
  rawBody,
}) {
  const resolvedTemperature = readSetting(settings, "temperature") ?? temperature;
  const resolvedTopP = readSetting(settings, "topP") ?? topP;
  const resolvedMaxTokens = readSetting(settings, "maxOutputTokens") ?? readSetting(settings, "maxTokens") ?? maxTokens;
  const resolvedPresencePenalty = readSetting(settings, "presencePenalty") ?? presencePenalty;
  const resolvedFrequencyPenalty = readSetting(settings, "frequencyPenalty") ?? frequencyPenalty;
  const resolvedStream = typeof stream === "boolean" ? stream : Boolean(readSetting(settings, "stream"));

  const body = {
    model,
    messages,
    stream: resolvedStream,
  };

  const normalizedTemperature = clampBodyNumber(providerId, "temperature", resolvedTemperature);
  const normalizedTopP = clampBodyNumber(providerId, "topP", resolvedTopP);
  const normalizedMaxTokens = clampBodyNumber(providerId, "maxOutputTokens", resolvedMaxTokens, { integer: true });
  const normalizedPresencePenalty = clampBodyNumber(providerId, "presencePenalty", resolvedPresencePenalty);
  const normalizedFrequencyPenalty = clampBodyNumber(providerId, "frequencyPenalty", resolvedFrequencyPenalty);

  if (normalizedTemperature !== null && isBodyParamAllowed(providerId, "temperature", { model, settings }))
    body.temperature = normalizedTemperature;
  if (normalizedTopP !== null && isBodyParamAllowed(providerId, "top_p", { model, settings }))
    body.top_p = normalizedTopP;
  if (normalizedMaxTokens !== null && isBodyParamAllowed(providerId, "max_tokens", { model, settings }))
    body.max_tokens = normalizedMaxTokens;
  if (normalizedPresencePenalty !== null && isBodyParamAllowed(providerId, "presence_penalty", { model, settings }))
    body.presence_penalty = normalizedPresencePenalty;
  if (normalizedFrequencyPenalty !== null && isBodyParamAllowed(providerId, "frequency_penalty", { model, settings }))
    body.frequency_penalty = normalizedFrequencyPenalty;

  const extensions = buildBodyExtensions({ providerId, model, settings });
  for (const [key, value] of Object.entries(extensions)) {
    if (value === undefined) continue;
    if (!isBodyParamAllowed(providerId, key, { model, settings })) continue;
    body[key] = value;
  }

  mergeRawBodyParams({ providerId, model, settings, body, rawBody });

  return body;
}

async function createChatCompletion({ providerId, model, messages, timeoutMs = llmConfig.timeoutMs, signal, ...rest } = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "chat/completions");
  const headerExtensions = buildHeaderExtensions({ providerId: provider.id, model, settings: rest?.settings }); // openrouter

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);
  const abortFromParent = () => abortController.abort(signal?.reason || new Error("Request cancelled"));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headerExtensions, // openrouter
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(
        buildBody({
          providerId: provider.id,
          model,
          messages,
          stream: false,
          ...rest,
        })
      ),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const { json, text } = await readJsonSafe(response);
      throw new Error(pickErrorMessage({ status: response.status, json, text }));
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message || {};
    const content = normalizeText(message?.content).trim();
    if (!content) {
      const toolCalls = message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        const names = toolCalls
          .map((toolCall) => toolCall?.function?.name)
          .filter(Boolean)
          .slice(0, 6)
          .join(", ");
        throw new Error(
          `Model requested tool calls (${names || toolCalls.length}), but tool calls are not implemented yet.`
        );
      }
      throw new Error("Empty model response");
    }
    return { content, raw: data };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function createChatCompletionStreamResponse({ providerId, model, messages, signal, ...rest } = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "chat/completions");
  const headerExtensions = buildHeaderExtensions({ providerId: provider.id, model, settings: rest?.settings }); // openrouter

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headerExtensions, // openrouter
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(
      buildBody({
        providerId: provider.id,
        model,
        messages,
        stream: true,
        ...rest,
      })
    ),
    signal,
  });

  if (!response.ok) {
    const { json, text } = await readJsonSafe(response);
    throw new Error(pickErrorMessage({ status: response.status, json, text }));
  }

  if (!response.body) {
    throw new Error("Upstream stream body is empty");
  }

  return response;
}

async function* streamChatCompletionDeltas({ response }) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex === -1) break;

      const frame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const lines = frame.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataPart = trimmed.slice("data:".length).trim();
        if (!dataPart) continue;
        if (dataPart === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(dataPart);
        } catch {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          yield delta;
        }
      }
    }
  }
}

module.exports = {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
};
