function isProduction(env = process.env) {
  return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function normalizedList(value, path) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${path} must be a non-empty array`);
  const list = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  if (!list.length) throw new Error(`${path} must contain at least one model id`);
  return Object.freeze(list);
}

function loadProductionModelPolicy(env = process.env) {
  if (!isProduction(env)) return null;
  const raw = String(env.CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON || "").trim();
  if (!raw) throw new Error("Production requires CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON must be an object");
  }
  if (!parsed.chat || typeof parsed.chat !== "object" || Array.isArray(parsed.chat)) {
    throw new Error("CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON.chat must be an object");
  }
  const chat = {};
  for (const [providerId, models] of Object.entries(parsed.chat)) {
    const normalizedProviderId = String(providerId || "").trim();
    if (!normalizedProviderId) throw new Error("Production chat model allowlist contains an empty provider id");
    chat[normalizedProviderId] = normalizedList(models, `Production chat model allowlist ${normalizedProviderId}`);
  }
  if (!Object.keys(chat).length) throw new Error("Production chat model allowlist cannot be empty");
  const memory = normalizedList(parsed.memory, "Production Memory model allowlist");
  return Object.freeze({ chat: Object.freeze(chat), memory });
}

function isChatModelAllowed(providerId, modelId, env = process.env) {
  const policy = loadProductionModelPolicy(env);
  if (!policy) return true;
  const provider = String(providerId || "").trim();
  const model = String(modelId || "").trim();
  return Boolean(provider && model && policy.chat[provider]?.includes(model));
}

function isMemoryModelAllowed(modelId, env = process.env) {
  const policy = loadProductionModelPolicy(env);
  if (!policy) return true;
  return policy.memory.includes(String(modelId || "").trim());
}

module.exports = { loadProductionModelPolicy, isChatModelAllowed, isMemoryModelAllowed };
