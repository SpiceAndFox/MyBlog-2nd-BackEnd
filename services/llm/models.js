const { getProviderDefinition } = require("./providers");

function normalizeProviderId(providerId) {
  return String(providerId || "").trim();
}

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function listModelsForProvider(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const definition = getProviderDefinition(normalizedProviderId);
  const models = Array.isArray(definition?.models) ? definition.models : [];
  return models
    .map((model) => {
      const id = String(model?.id || "").trim();
      if (!id) return null;
      const entry = { id, name: model.name };
      if (model.defaults && typeof model.defaults === "object" && !Array.isArray(model.defaults)) {
        entry.defaults = model.defaults;
      }
      if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length) {
        entry.reasoningEfforts = model.reasoningEfforts;
      }
      return entry;
    })
    .filter(Boolean);
}

function isSupportedModel(providerId, modelId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedProviderId || !normalizedModelId) return false;

  return listModelsForProvider(normalizedProviderId).some((model) => String(model?.id || "").trim() === normalizedModelId);
}

module.exports = {
  listModelsForProvider,
  isSupportedModel,
};
