const grok = require("./grok");
const deepseek = require("./deepseek");
const gemini = require("./gemini");
const openrouter = require("./openrouter");
const opencodeZenClaude = require("./opencodeZenClaude");

const PROVIDER_DEFINITIONS = [grok, deepseek, gemini, openrouter, opencodeZenClaude]
  .map((provider) => (provider && typeof provider === "object" ? provider : null))
  .filter(Boolean);

const PROVIDER_BY_ID = new Map(PROVIDER_DEFINITIONS.map((provider) => [String(provider.id || "").trim(), provider]));

function normalizeProviderId(providerId) {
  return String(providerId || "").trim();
}

function firstEnvValue(keys) {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isSupportedProvider(providerId) {
  const normalizedId = normalizeProviderId(providerId);
  return Boolean(normalizedId && PROVIDER_BY_ID.has(normalizedId));
}

function getProviderDefinition(providerId) {
  const normalizedId = normalizeProviderId(providerId);
  if (!normalizedId) return null;
  return PROVIDER_BY_ID.get(normalizedId) || null;
}

function listSupportedProviders() {
  return PROVIDER_DEFINITIONS.map((definition) => ({
    id: String(definition.id || "").trim(),
    name: String(definition.name || "").trim(),
  })).filter((provider) => provider.id && provider.name);
}

function isProviderConfigured(providerId) {
  const definition = getProviderDefinition(providerId);
  if (!definition) return false;
  if (!firstEnvValue(definition.apiKeyEnv)) return false;

  const baseUrlEnv = Array.isArray(definition.baseUrlEnv) ? definition.baseUrlEnv : [];
  if (!baseUrlEnv.length) return true;
  return Boolean(firstEnvValue(baseUrlEnv));
}

function listConfiguredProviders() {
  return listSupportedProviders().filter((provider) => isProviderConfigured(provider.id));
}

function getProviderConfig(providerId) {
  const definition = getProviderDefinition(providerId);
  const normalizedId = normalizeProviderId(providerId);
  if (!definition) throw new Error(`Unsupported provider: ${normalizedId || "(empty)"}`);

  const apiKey = firstEnvValue(definition.apiKeyEnv);
  if (!apiKey) {
    const keys = Array.isArray(definition.apiKeyEnv) ? definition.apiKeyEnv : [];
    throw new Error(`Missing API key for provider ${normalizedId}. Please set one of: ${keys.join(", ")}`);
  }

  const baseUrl = firstEnvValue(definition.baseUrlEnv);
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

module.exports = {
  isSupportedProvider,
  getProviderDefinition,
  getProviderConfig,
  listSupportedProviders,
  listConfiguredProviders,
  isProviderConfigured,
  isBodyParamAllowed,
};
