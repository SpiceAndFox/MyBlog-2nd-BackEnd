const generic = require("./generic/profile");
const opencodeGo = require("./opencodeGo/profile");
const openrouter = require("./openrouter/profile");
const bai = require("./bai/profile");
const { validatePolicyDeclaration } = require("../policies/policyDeclaration");

function assertId(id, label) {
  if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
    throw new Error(`${label} requires an exact, non-empty ID without surrounding whitespace`);
  }
}

// Explicit imports make registration reviewable. Duplicate IDs and malformed
// declarations fail before a request can select an ambiguous rule.
function createGatewayRegistry(profiles) {
  const registry = new Map();
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object" || !Array.isArray(profile.models)) {
      throw new Error("Gateway profile must declare a models array");
    }
    assertId(profile.id, "Gateway");
    if (registry.has(profile.id)) throw new Error(`Duplicate gateway: ${profile.id}`);
    const models = new Map();
    for (const model of profile.models) {
      if (!model || typeof model !== "object") throw new Error(`Gateway ${profile.id} model must be an object`);
      assertId(model.id, `Gateway ${profile.id} model`);
      if (models.has(model.id)) throw new Error(`Duplicate model: ${profile.id}/${model.id}`);
      models.set(model.id, validatePolicyDeclaration(model.policy, `${profile.id}/${model.id}`));
    }
    registry.set(profile.id, Object.freeze({
      defaults: validatePolicyDeclaration(profile.defaults, `${profile.id} defaults`),
      models: Object.freeze(Object.fromEntries(models)),
    }));
  }
  return Object.freeze({
    get(profile) {
      if (!registry.has(profile)) throw new Error(`CHAT_MEMORY_V2_PROVIDER_PROFILE must be one of: ${[...registry.keys()].join(", ")}`);
      return registry.get(profile);
    },
  });
}

const gatewayRegistry = createGatewayRegistry([generic, opencodeGo, openrouter, bai]);
module.exports = { gatewayRegistry, createGatewayRegistry };
