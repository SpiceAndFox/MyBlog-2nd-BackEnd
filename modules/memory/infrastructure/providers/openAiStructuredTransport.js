const {
  assertStructuredRequestLimits,
  isSafetySignal,
} = require("./providerProtocol");
const { buildOpenAiHttpRequest } = require("./structuredHttpRequest");
const { parseStrictJsonContent } = require("./structuredJsonContent");

function createOpenAiStructuredTransport({
  baseUrl,
  apiKey,
  model,
  proposerModels = {},
  timeoutMs,
  maxInputTokens,
  maxOutputTokens,
  fetchImpl = globalThis.fetch,
  extraHeaders = {},
  extraBody = {},
  compileSchema = (schema) => schema,
  httpRequestBuilder = buildOpenAiHttpRequest,
  parseContent = parseStrictJsonContent,
  validateOutputSchema = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const providerConfig = { baseUrl, model, proposerModels, maxOutputTokens };
  return async function invokeStructured(request) {
    const { endpoint, body } = httpRequestBuilder(providerConfig, request, {
      compileSchema,
      extraBody,
    });
    assertStructuredRequestLimits({ messages: body.messages, maxInputTokens, maxOutputTokens });
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
      const message = choice?.message;
      const finishReason = choice?.finish_reason ?? choice?.stop_reason;
      if (message?.refusal || isSafetySignal(finishReason)) return { refusal: true, finishReason, model: data?.model ?? requestedModel, usage: data?.usage };
      const content = message?.parsed ?? message?.content;
      const rawOutput = message?.content ?? message?.parsed;
      let output = content;
      let transportError = null;
      let transportRecovery = null;
      let outputSchemaValidation = null;
      if (content == null) {
        output = null;
        transportError = "content_missing";
      } else if (typeof content === "string") {
        const parsed = parseContent(content, {
          finishReason,
          validateCandidate: typeof validateOutputSchema === "function"
            ? (candidate) => validateOutputSchema(request?.responseSchema?.schema, candidate)
            : null,
        });
        output = parsed.output;
        transportError = parsed.transportError;
        transportRecovery = parsed.transportRecovery;
        outputSchemaValidation = parsed.schemaValidation;
      }
      if (!transportError && !outputSchemaValidation && typeof validateOutputSchema === "function") {
        outputSchemaValidation = validateOutputSchema(request?.responseSchema?.schema, output);
      }
      return {
        output,
        rawOutput,
        finishReason,
        model: data?.model ?? requestedModel,
        usage: data?.usage ?? null,
        transportError,
        transportRecovery,
        outputSchemaErrors: outputSchemaValidation?.ok === false
          ? outputSchemaValidation.errors
          : null,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createOpenAiStructuredTransport };
