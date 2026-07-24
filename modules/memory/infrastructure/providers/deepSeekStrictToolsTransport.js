const { compileDeepSeekSchema } = require("./deepSeekSchemaCompiler");
const { isSafetySignal, assertStructuredRequestLimits } = require("./providerProtocol");
const { resolveMemoryProviderModel } = require("../../config/loadProviderConfig");

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return { output: value, recovery: null, error: null };
  if (typeof value !== "string") return { output: null, recovery: null, error: "tool_arguments_missing" };
  try {
    return { output: JSON.parse(value), recovery: null, error: null };
  } catch {
    let candidate = value.trim();
    for (let removed = 1; removed <= 2 && candidate.endsWith("}"); removed += 1) {
      candidate = candidate.slice(0, -1).trimEnd();
      try {
        return { output: JSON.parse(candidate), recovery: `trimmed_${removed}_trailing_brace`, error: null };
      } catch {
        // Only a complete standard JSON parse may authorize this narrow recovery.
      }
    }
    return { output: null, recovery: null, error: "tool_arguments_invalid_json" };
  }
}

function createDeepSeekStrictToolsTransport({ baseUrl, apiKey, model, proposerModels = {}, timeoutMs, maxInputTokens, maxOutputTokens = 8192, thinkingMode = "disabled", fetchImpl = globalThis.fetch, extraHeaders = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (normalizedBaseUrl.hostname === "api.deepseek.com" && !normalizedBaseUrl.pathname.endsWith("/beta/")) {
    throw new Error("DeepSeek strict tools require CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://api.deepseek.com/beta");
  }
  const endpoint = new URL("chat/completions", normalizedBaseUrl).toString();

  const providerConfig = { model, proposerModels };
  return async function invokeStructured({ proposer, systemPrompt, userPayload, responseSchema }) {
    const requestedModel = resolveMemoryProviderModel(providerConfig, proposer);
    const functionName = responseSchema?.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(functionName || ""))) throw new Error("Structured output schema name is not a valid tool name");
    assertStructuredRequestLimits({ systemPrompt, userPayload, maxInputTokens, maxOutputTokens });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Memory Provider request timeout")), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify({
          model: requestedModel,
          stream: false,
          max_tokens: maxOutputTokens,
          thinking: { type: thinkingMode },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
          tools: [{
            type: "function",
            function: {
              name: functionName,
              description: "Return the schema-constrained Memory proposer result.",
              strict: true,
              parameters: compileDeepSeekSchema(responseSchema.schema),
            },
          }],
          tool_choice: { type: "function", function: { name: functionName } },
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (isSafetySignal(data?.error?.code, data?.error?.type, data?.error?.message)) {
          return { safetyBlocked: true, finishReason: data?.error?.code ?? "input_rejected", model: data?.model ?? requestedModel, usage: data?.usage ?? null };
        }
        const error = new Error(data?.error?.message || `Memory Provider HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const choice = data?.choices?.[0];
      const finishReason = choice?.finish_reason ?? choice?.stop_reason;
      if (isSafetySignal(finishReason, choice?.message?.refusal)) {
        return { safetyBlocked: true, finishReason, model: data?.model ?? requestedModel, usage: data?.usage };
      }
      const toolCall = choice?.message?.tool_calls?.find((entry) => entry?.function?.name === functionName);
      const parsed = toolCall
        ? parseToolArguments(toolCall?.function?.arguments)
        : { output: null, recovery: null, error: "tool_call_missing" };
      return {
        output: parsed.output,
        finishReason,
        model: data?.model ?? requestedModel,
        usage: data?.usage ?? null,
        transportError: parsed.error,
        transportRecovery: parsed.recovery,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createDeepSeekStrictToolsTransport, parseToolArguments };
