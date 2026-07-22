const { createProviderRegistry } = require("./providerRegistry");
const { createSettingsSchema } = require("./settingsSchema");
const { createModelCatalog } = require("./models");
const { createChatCompletionGateway } = require("./chatCompletionGateway");

function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildOpenRouterAttribution(environment) {
  const headers = {};
  const siteUrl = normalizeOptionalString(environment?.OPENROUTER_SITE_URL);
  const appName = normalizeOptionalString(environment?.OPENROUTER_APP_NAME);
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  if (appName) headers["X-OpenRouter-Title"] = appName;
  return Object.freeze(headers);
}

function createChatLlmCatalog({ environment } = {}) {
  const openRouterAttribution = buildOpenRouterAttribution(environment);
  const providers = createProviderRegistry({ environment, openRouterAttribution });
  const settingsSchema = createSettingsSchema({ providers });
  const models = createModelCatalog({ providers });
  return Object.freeze({ models, openRouterAttribution, providers, settingsSchema });
}

function createChatLlmRuntime({ catalog, config, adapters = {} } = {}) {
  if (!catalog?.providers || !catalog?.settingsSchema || !catalog?.models) {
    throw new Error("Chat LLM catalog is required");
  }
  const completions = createChatCompletionGateway({
    providers: catalog.providers,
    settingsSchema: catalog.settingsSchema,
    config,
    adapters: adapters.completionAdapters,
    fetchImpl: adapters.fetchImpl,
    GoogleGenAIClass: adapters.GoogleGenAIClass,
  });
  return Object.freeze({
    ...catalog,
    ...completions,
  });
}

module.exports = { buildOpenRouterAttribution, createChatLlmCatalog, createChatLlmRuntime };
