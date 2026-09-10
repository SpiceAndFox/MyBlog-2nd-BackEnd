const {
  assertStructuredRequestLimits,
  isAbortedIncompleteJson,
  isSafetySignal,
} = require("./providerProtocol");
const { buildDeepSeekHttpRequest, normalizeBaseUrl } = require("./structuredHttpRequest");
const { parseStrictJsonContent } = require("./structuredJsonContent");
const { validateProviderWireOutput } = require("./validateProviderWireOutput");
const { providerWireSchemaMetadata } = require("./providerProtocolMetadata");

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

function createDeepSeekStrictToolsTransport({ baseUrl, apiKey, model, proposerModels = {}, timeoutMs, maxInputTokens, maxOutputTokens, thinkingMode, reasoningEffort, fetchImpl = globalThis.fetch, extraHeaders = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (normalizedBaseUrl.hostname === "api.deepseek.com" && !normalizedBaseUrl.pathname.endsWith("/beta/")) {
    throw new Error("DeepSeek strict tools require CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://api.deepseek.com/beta");
  }
  const providerConfig = { baseUrl, model, proposerModels, maxOutputTokens, thinkingMode, reasoningEffort };
  return async function invokeStructured(request) {
    const { responseSchema } = request;
    const functionName = responseSchema?.name;
    const { endpoint, body, schemaDiagnostics } = buildDeepSeekHttpRequest(providerConfig, request);
    const wireMetadata = providerWireSchemaMetadata(body);
    assertStructuredRequestLimits({ ...body, maxInputTokens, maxOutputTokens });
    const requestedModel = body.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Memory Provider request timeout")), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
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
      // With thinking enabled DeepSeek requires auto tool choice and can return
      // the same JSON in content. Accept it only after the full bound schema
      // passes locally; never replace malformed or unexpected tool calls.
      const content = choice?.message?.content;
      if (thinkingMode === "enabled" && !choice?.message?.tool_calls?.length
        && typeof content === "string" && content.trim()) {
        const parsed = parseStrictJsonContent(content, { finishReason });
        const validation = parsed.transportError ? null : validateProviderWireOutput(responseSchema, parsed.output);
        return {
          output: validation?.output ?? parsed.output,
          outputChannel: "content",
          ...wireMetadata,
          schemaDiagnostics,
          rawSchemaValid: validation?.rawSchemaValid ?? false,
          wireNormalizations: validation?.normalizations ?? [],
          rawOutput: content,
          finishReason,
          model: data?.model ?? requestedModel,
          usage: data?.usage ?? null,
          transportError: parsed.transportError,
          transportRecovery: validation?.ok ? "accepted_schema_valid_json_content" : null,
          ...(validation && !validation.ok ? { outputSchemaErrors: validation.errors } : {}),
        };
      }
      const rawOutput = toolCall?.function?.arguments;
      const parsed = toolCall
        ? parseToolArguments(toolCall?.function?.arguments)
        : { output: null, recovery: null, error: "tool_call_missing" };
      if (
        parsed.error === "tool_arguments_invalid_json"
        && isAbortedIncompleteJson(rawOutput, finishReason)
      ) {
        parsed.error = "tool_arguments_incomplete_json";
      }
      const validation = parsed.error ? null : validateProviderWireOutput(responseSchema, parsed.output);
      return {
        output: validation?.output ?? parsed.output,
        outputChannel: "tool_arguments",
        ...wireMetadata,
        schemaDiagnostics,
        rawSchemaValid: validation?.rawSchemaValid ?? false,
        wireNormalizations: validation?.normalizations ?? [],
        ...(validation && !validation.ok ? { outputSchemaErrors: validation.errors } : {}),
        rawOutput,
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
