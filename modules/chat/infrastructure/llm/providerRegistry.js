const grok = require("./providerDefinitions/grok");
const deepseek = require("./providerDefinitions/deepseek");
const gemini = require("./providerDefinitions/gemini");
const { createOpenRouterDefinition } = require("./providerDefinitions/openrouter");
const opencodeGoOpenai = require("./providerDefinitions/opencodeGoOpenai");
const opencodeGoMessages = require("./providerDefinitions/opencodeGoMessages");
const opencodeZenClaude = require("./providerDefinitions/opencodeZenClaude");

function normalizeProviderId(providerId) {
  return String(providerId || "").trim();
}

function firstEnvValue(keys, environment) {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const value = environment[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function createProviderRegistry({ environment, openRouterAttribution = {} } = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Provider registry environment is required");
  }
  const providerEnvironment = Object.freeze({ ...environment });
  const providerDefinitions = [
    grok,
    deepseek,
    gemini,
    createOpenRouterDefinition({ attributionHeaders: openRouterAttribution }),
    opencodeGoOpenai,
    opencodeGoMessages,
    opencodeZenClaude,
  ]
    .map((provider) => (provider && typeof provider === "object" ? Object.freeze(provider) : null))
    .filter(Boolean);
  const providerById = new Map(providerDefinitions.map((provider) => [String(provider.id || "").trim(), provider]));

  function isSupportedProvider(providerId) {
    const normalizedId = normalizeProviderId(providerId);
    return Boolean(normalizedId && providerById.has(normalizedId));
  }

  function getProviderDefinition(providerId) {
    const normalizedId = normalizeProviderId(providerId);
    if (!normalizedId) return null;
    return providerById.get(normalizedId) || null;
  }

  function listSupportedProviders() {
    return providerDefinitions.map((definition) => ({
      id: String(definition.id || "").trim(),
      name: String(definition.name || "").trim(),
    })).filter((provider) => provider.id && provider.name);
  }

  function isProviderConfigured(providerId) {
    const definition = getProviderDefinition(providerId);
    if (!definition) return false;
    if (!firstEnvValue(definition.apiKeyEnv, providerEnvironment)) return false;

    const baseUrlEnv = Array.isArray(definition.baseUrlEnv) ? definition.baseUrlEnv : [];
    if (!baseUrlEnv.length) return true;
    return Boolean(firstEnvValue(baseUrlEnv, providerEnvironment));
  }

  function listConfiguredProviders() {
    return listSupportedProviders().filter((provider) => isProviderConfigured(provider.id));
  }

  function getProviderConfig(providerId) {
    const definition = getProviderDefinition(providerId);
    const normalizedId = normalizeProviderId(providerId);
    if (!definition) throw new Error(`Unsupported provider: ${normalizedId || "(empty)"}`);

    const apiKey = firstEnvValue(definition.apiKeyEnv, providerEnvironment);
    if (!apiKey) {
      const keys = Array.isArray(definition.apiKeyEnv) ? definition.apiKeyEnv : [];
      throw new Error(`Missing API key for provider ${normalizedId}. Please set one of: ${keys.join(", ")}`);
    }

    const baseUrl = firstEnvValue(definition.baseUrlEnv, providerEnvironment);
    if (!baseUrl) {
      const keys = Array.isArray(definition.baseUrlEnv) ? definition.baseUrlEnv : [];
      throw new Error(`Missing base URL for provider ${normalizedId}. Please set one of: ${keys.join(", ")}`);
    }

    return { id: normalizedId, name: definition.name, apiKey, baseUrl };
  }

  function isBodyParamAllowed(providerId, paramName, context = {}) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const definition = getProviderDefinition(normalizedProviderId);
    const normalizedParamName = String(paramName || "").trim();
    if (!normalizedParamName) return true;

    const policyFn = definition?.parameterPolicy?.isBodyParamAllowed;
    if (typeof policyFn === "function") {
      const value = policyFn({
        providerId: normalizedProviderId,
        paramName: normalizedParamName,
        model: context?.model,
        settings: context?.settings,
      });
      if (typeof value === "boolean") return value;
    }

    const blocked = Array.isArray(definition?.parameterPolicy?.blockedBodyParams)
      ? definition.parameterPolicy.blockedBodyParams
      : [];
    if (!blocked.length) return true;
    return !blocked.includes(normalizedParamName);
  }

  return Object.freeze({
    isSupportedProvider,
    getProviderDefinition,
    getProviderConfig,
    listSupportedProviders,
    listConfiguredProviders,
    isProviderConfigured,
    isBodyParamAllowed,
  });
}

module.exports = { createProviderRegistry };
