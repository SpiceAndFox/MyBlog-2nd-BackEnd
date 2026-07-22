const { iterateSseData } = require("../sse");

function createAnthropicMessagesAdapter({ providers, settingsSchema, config: llmConfig, fetchImpl = globalThis.fetch } = {}) {
  if (!providers?.getProviderConfig || !providers?.isBodyParamAllowed) {
    throw new Error("Anthropic Messages adapter requires a provider registry");
  }
  if (!settingsSchema?.getGlobalNumericRange || !settingsSchema?.getProviderNumericRange || !settingsSchema?.clampNumberWithRange) {
    throw new Error("Anthropic Messages adapter requires a settings schema");
  }
  if (!Number.isFinite(llmConfig?.timeoutMs) || llmConfig.timeoutMs <= 0) throw new Error("Anthropic Messages adapter timeout is required");
  if (typeof fetchImpl !== "function") throw new Error("Anthropic Messages adapter fetch implementation is required");
  const { getProviderConfig, isBodyParamAllowed } = providers;
  const { getGlobalNumericRange, getProviderNumericRange, clampNumberWithRange } = settingsSchema;

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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readSetting(settings, key) {
  if (!isPlainObject(settings)) return undefined;
  return settings[key];
}

function normalizeText(value) {
  return String(value || "");
}

function hasObjectEntries(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function clampBodyNumber(providerId, key, value, { integer } = {}) {
  const range = getProviderNumericRange(providerId, key) || getGlobalNumericRange(key);
  const nextValue = clampNumberWithRange(value, range);
  if (!Number.isFinite(nextValue)) return null;
  return integer ? Math.trunc(nextValue) : nextValue;
}

function buildWebSearchTools({ providerId, model, settings } = {}) {
  if (!readSetting(settings, "enableWebSearch")) return [];
  if (!isBodyParamAllowed(providerId, "tools", { model, settings })) return [];

  const tool = {
    type: "web_search_20250305",
    name: "web_search",
  };

  const maxUses = clampBodyNumber(providerId, "webSearchMaxUses", readSetting(settings, "webSearchMaxUses"), {
    integer: true,
  });
  if (maxUses !== null) tool.max_uses = maxUses;

  return [tool];
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
  if (isPlainObject(json)) {
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

function buildAnthropicMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("Anthropic Messages adapter requires messages to be an array");

  const systemParts = [];
  const outputMessages = [];

  for (const [index, message] of messages.entries()) {
    if (!isPlainObject(message)) throw new Error(`Invalid message at index ${index}`);

    const role = String(message.role || "").trim();
    if (typeof message.content !== "string") {
      throw new Error(`Anthropic Messages adapter requires string content at index ${index}`);
    }

    const content = message.content.trim();
    if (!role) throw new Error(`Missing message role at index ${index}`);
    if (!content) throw new Error(`Missing message content at index ${index}`);

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    if (role !== "user" && role !== "assistant") {
      throw new Error(`Unsupported Anthropic message role at index ${index}: ${role}`);
    }

    outputMessages.push({ role, content });
  }

  if (!outputMessages.length) throw new Error("Anthropic Messages adapter requires at least one user/assistant message");

  return {
    system: systemParts.join("\n\n").trim(),
    messages: outputMessages,
  };
}

function assertNoUnsupportedRawPayloads({ rawBody, rawConfig } = {}) {
  if (hasObjectEntries(rawBody)) {
    throw new Error("rawBody is OpenAI-compatible only and cannot be used with the Anthropic Messages adapter");
  }
  if (hasObjectEntries(rawConfig)) {
    throw new Error("rawConfig is Google GenAI only and cannot be used with the Anthropic Messages adapter");
  }
}

function buildBody({ providerId, model, messages, temperature, topP, maxTokens, stream, settings, rawBody, rawConfig }) {
  assertNoUnsupportedRawPayloads({ rawBody, rawConfig });

  const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);

  const resolvedTemperature = readSetting(settings, "temperature") ?? temperature;
  const resolvedTopP = readSetting(settings, "topP") ?? topP;
  const resolvedMaxTokens = readSetting(settings, "maxOutputTokens") ?? readSetting(settings, "maxTokens") ?? maxTokens;
  const resolvedStream = typeof stream === "boolean" ? stream : Boolean(readSetting(settings, "stream"));

  const normalizedTemperature = clampBodyNumber(providerId, "temperature", resolvedTemperature);
  const normalizedTopP = clampBodyNumber(providerId, "topP", resolvedTopP);
  const normalizedMaxTokens = clampBodyNumber(providerId, "maxOutputTokens", resolvedMaxTokens, { integer: true });

  if (normalizedMaxTokens === null) {
    throw new Error("Anthropic Messages adapter requires maxOutputTokens");
  }

  const body = {
    model,
    max_tokens: normalizedMaxTokens,
    messages: anthropicMessages,
    stream: resolvedStream,
  };

  if (system) body.system = system;
  if (normalizedTemperature !== null && isBodyParamAllowed(providerId, "temperature", { model, settings })) {
    body.temperature = normalizedTemperature;
  }
  if (normalizedTopP !== null && isBodyParamAllowed(providerId, "top_p", { model, settings })) {
    body.top_p = normalizedTopP;
  }

  const tools = buildWebSearchTools({ providerId, model, settings });
  if (tools.length) body.tools = tools;

  return body;
}

function extractResponseContent(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const textParts = [];
  const toolNames = [];

  for (const block of blocks) {
    if (!isPlainObject(block)) throw new Error("Invalid Anthropic response content block");

    if (block.type === "text") {
      textParts.push(normalizeText(block.text));
      continue;
    }

    if (
      block.type === "server_tool_use" ||
      block.type === "web_search_tool_result" ||
      block.type === "thinking" ||
      block.type === "redacted_thinking"
    ) {
      continue;
    }

    if (block.type === "tool_use") {
      toolNames.push(String(block.name || "").trim());
      continue;
    }

    throw new Error(`Unsupported Anthropic response content block type: ${String(block.type || "(empty)")}`);
  }

  const content = textParts.join("").trim();
  if (content) return content;

  if (data?.stop_reason === "pause_turn") {
    throw new Error("Model paused while executing server tools, but pause_turn continuation is not implemented yet.");
  }

  if (toolNames.length || data?.stop_reason === "tool_use") {
    const names = toolNames.filter(Boolean).slice(0, 6).join(", ");
    throw new Error(
      `Model requested tool use (${names || toolNames.length || "unknown"}), but tool calls are not implemented yet.`
    );
  }

  throw new Error("Empty model response");
}

async function createChatCompletion({
  providerId,
  model,
  messages,
  timeoutMs = llmConfig.timeoutMs,
  signal,
  settings,
  rawBody,
  rawConfig,
  ...rest
} = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "messages");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      abortController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
    }
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": provider.apiKey,
      },
      body: JSON.stringify(
        buildBody({
          providerId: provider.id,
          model,
          messages,
          stream: false,
          settings,
          rawBody,
          rawConfig,
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
    return { content: extractResponseContent(data), raw: data };
  } finally {
    clearTimeout(timeout);
  }
}

async function createChatCompletionStreamResponse({
  providerId,
  model,
  messages,
  signal,
  settings,
  rawBody,
  rawConfig,
  ...rest
} = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "messages");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider.apiKey,
    },
    body: JSON.stringify(
      buildBody({
        providerId: provider.id,
        model,
        messages,
        stream: true,
        settings,
        rawBody,
        rawConfig,
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
  for await (const dataPart of iterateSseData(response.body)) {
    const normalized = dataPart.trim();
    if (!normalized || normalized === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(dataPart);
    } catch (error) {
      throw new Error(`Invalid Anthropic stream JSON: ${error.message}`);
    }
    if (parsed?.type === "error") {
      throw new Error(pickErrorMessage({ status: 500, json: parsed, text: "" }));
    }
    if (parsed?.type === "message_delta" && parsed?.delta?.stop_reason === "pause_turn") {
      throw new Error("Model paused while executing server tools, but pause_turn continuation is not implemented yet.");
    }
    if (parsed?.type === "content_block_start" && parsed?.content_block?.type === "text") {
      const text = parsed.content_block.text;
      if (typeof text === "string" && text.length) yield { type: "delta", delta: text };
    }
    if (parsed?.type === "content_block_start" && parsed?.content_block?.type === "tool_use") {
      const name = String(parsed.content_block.name || "").trim();
      throw new Error(`Model requested tool use (${name || "unknown"}), but tool calls are not implemented yet.`);
    }
    const delta = parsed?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length) {
      yield { type: "delta", delta: delta.text };
    }
  }
}

return Object.freeze({
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
});
}

module.exports = { createAnthropicMessagesAdapter };
