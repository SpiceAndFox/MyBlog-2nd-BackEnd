const { gatewayRegistry } = require("../gateways/registry");
const { DEFAULT_POLICY, validatePolicyDeclaration } = require("./policyDeclaration");
const { buildProviderInferenceControls, validateProviderOutputMode } = require("./providerInference");
const { normalizeProviderAdapter } = require("../../../config/providerAdapters");
const {
  PROPOSER_IDS, resolveMemoryProviderModel,
  resolveMemoryProviderReasoningEffort, resolveMemoryProviderThinkingMode,
} = require("../../../config/loadProviderConfig");

function resolveProviderPolicy(config, model) {
  const profile = config.profile || "generic";
  const definition = gatewayRegistry.get(profile);
  const builtin = Object.hasOwn(definition.models, model) ? definition.models[model] : {};
  const custom = Object.hasOwn(config.modelRules || {}, model) ? config.modelRules[model] : {};
  return Object.freeze({
    ...DEFAULT_POLICY, ...definition.defaults,
    ...validatePolicyDeclaration(config.policy || {}), ...builtin,
    ...validatePolicyDeclaration(custom),
    profile, model,
  });
}

function resolveMemoryProviderRequestPolicy(config, proposer) {
  const policy = resolveProviderPolicy(config, resolveMemoryProviderModel(config, proposer));
  validateProviderOutputMode(policy, config.adapter);
  const controls = buildProviderInferenceControls(policy, {
    reasoningEffort: resolveMemoryProviderReasoningEffort(config, proposer),
    thinkingMode: resolveMemoryProviderThinkingMode(config, proposer),
  });
  return { policy, controls };
}

function validateModelRules(rules) {
  const label = "CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON";
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error(`${label} must be an object`);
  return Object.freeze(Object.fromEntries(Object.entries(rules).map(([model, rule]) => {
    if (!model.trim() || model !== model.trim()) throw new Error(`${label} requires exact, non-empty model IDs without surrounding whitespace`);
    return [model, validatePolicyDeclaration(rule, `${label}.${model}`)];
  })));
}

function initializeProviderConfig(configuration) {
  const config = normalizeProviderAdapter(configuration);
  if (config.adapter === "deepseek-strict-tools") return Object.freeze(config);
  config.policy = validatePolicyDeclaration(config.policy || {}, "CHAT_MEMORY_V2_PROVIDER_POLICY_JSON");
  config.modelRules = validateModelRules(config.modelRules ?? {});
  for (const proposer of [undefined, ...PROPOSER_IDS]) resolveMemoryProviderRequestPolicy(config, proposer);
  return Object.freeze(config);
}

module.exports = { resolveProviderPolicy, resolveMemoryProviderRequestPolicy, initializeProviderConfig };
