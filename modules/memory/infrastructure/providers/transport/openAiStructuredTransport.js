const { providerTimeoutError, providerHttpError, readProviderJson } = require("./providerFailure");
const {
  assertStructuredRequestLimits,
  isSafetySignal,
} = require("./providerProtocol");
const { buildOpenAiHttpRequest } = require("./structuredHttpRequest");
const { parseStrictJsonContent } = require("./structuredJsonContent");
const { validateProviderWireOutput } = require("../output/validateProviderWireOutput");
const { providerWireSchemaMetadata } = require("../output/providerProtocolMetadata");

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
    const { endpoint, body, headers: gatewayHeaders, providerPolicy } = httpRequestBuilder(providerConfig, request, {
      compileSchema,
      extraBody,
    });
    assertStructuredRequestLimits({ ...body, maxInputTokens, maxOutputTokens });
    const requestedModel = body.model;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders };
    for (const [key, value] of Object.entries(gatewayHeaders || {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      }
      headers[key] = value;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(providerTimeoutError()), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readProviderJson(response);
      if (!response.ok) {
        if (isSafetySignal(data?.error?.code, data?.error?.type, data?.error?.message)) {
          return { safetyBlocked: true, finishReason: data?.error?.code ?? "input_rejected", model: data?.model ?? requestedModel, usage: data?.usage ?? null };
        }
        throw providerHttpError(response, data);
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
      if (!transportError) {
        outputSchemaValidation = validateProviderWireOutput(request.responseSchema, output);
        output = outputSchemaValidation.output;
      }
      return {
        output,
        ...(providerPolicy ? { providerPolicy } : {}),
        outputChannel: "content",
        ...providerWireSchemaMetadata(body),
        rawSchemaValid: outputSchemaValidation?.rawSchemaValid ?? false,
        wireNormalizations: outputSchemaValidation?.normalizations ?? [],
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
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createOpenAiStructuredTransport };
