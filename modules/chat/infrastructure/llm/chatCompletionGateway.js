const { createOpenAiCompatibleAdapter } = require("./adapters/openAiCompatible");
const { createGoogleGenAiAdapter } = require("./adapters/googleGenAi");
const { createAnthropicMessagesAdapter } = require("./adapters/anthropicMessages");

function createChatCompletionGateway({ providers, settingsSchema, config, adapters = {}, fetchImpl, GoogleGenAIClass } = {}) {
  if (typeof providers?.getProviderDefinition !== "function") {
    throw new Error("Chat completion gateway requires a provider registry");
  }
  const dependencies = { providers, settingsSchema, config, fetchImpl, GoogleGenAIClass };
  const openaiCompatible = adapters.openAiCompatible || createOpenAiCompatibleAdapter(dependencies);
  const googleGenAi = adapters.googleGenAi || createGoogleGenAiAdapter(dependencies);
  const anthropicMessages = adapters.anthropicMessages || createAnthropicMessagesAdapter(dependencies);
  const { getProviderDefinition } = providers;

function resolveAdapter(providerId) {
  const adapterId = String(getProviderDefinition(providerId)?.adapter || "openai-compatible").trim();

  if (adapterId === "openai-compatible" || adapterId === "openaiCompatible") {
    return openaiCompatible;
  }

  if (adapterId === "google-genai" || adapterId === "googleGenAi" || adapterId === "gemini") {
    return googleGenAi;
  }

  if (adapterId === "anthropic-messages" || adapterId === "anthropicMessages") {
    return anthropicMessages;
  }

  throw new Error(`Unsupported LLM adapter: ${adapterId || "(empty)"}`);
}

async function createChatCompletion(options = {}) {
  return resolveAdapter(options.providerId).createChatCompletion(withModelTimeout(options));
}

async function createChatCompletionStreamResponse(options = {}) {
  return resolveAdapter(options.providerId).createChatCompletionStreamResponse(withModelTimeout(options));
}

function withModelTimeout(options) {
  const model = getProviderDefinition(options.providerId)?.models?.find(entry => entry.id === options.model);
  if (options.timeoutMs !== undefined || !model?.requestTimeoutMs) return options;
  return { ...options, timeoutMs: Math.max(config.timeoutMs, model.requestTimeoutMs) };
}

function streamChatCompletionDeltas(options = {}) {
  return resolveAdapter(options.providerId).streamChatCompletionDeltas(options);
}

return Object.freeze({
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
});
}

module.exports = { createChatCompletionGateway };
