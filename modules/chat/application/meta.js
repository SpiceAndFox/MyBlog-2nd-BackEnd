function createGetChatMetaUseCase({ config, providers, models, isModelAllowed } = {}) {
  if (!config || typeof config !== "object") throw new Error("Chat meta config is required");
  if (!providers?.getProviderDefinition || !providers?.listConfiguredProviders || !providers?.listSupportedProviders) {
    throw new Error("Chat provider catalog is required");
  }
  if (!models?.isSupportedModel || !models?.listModelsForProvider) throw new Error("Chat model catalog is required");
  if (typeof isModelAllowed !== "function") throw new Error("Chat production model policy is required");

  function resolveDefaultModelId(providerId) {
    const configured = config.defaultModelByProvider?.[providerId];
    const fallback = models.listModelsForProvider(providerId).find((model) => isModelAllowed(providerId, model.id))?.id || "";
    return (
      typeof configured === "string"
      && models.isSupportedModel(providerId, configured)
      && isModelAllowed(providerId, configured)
        ? configured.trim()
        : fallback
    ) || "";
  }

  return async function getChatMeta() {
    const configured = providers.listConfiguredProviders();
    const baseProviders = configured.length ? configured : providers.listSupportedProviders();
    const availableProviders = baseProviders
      .map((provider) => {
        const id = String(provider?.id || "").trim();
        const name = String(provider?.name || "").trim();
        const availableModels = models.listModelsForProvider(id).filter((model) => isModelAllowed(id, model.id));
        const definition = providers.getProviderDefinition(id);
        const defaultModelId = resolveDefaultModelId(id);
        const defaultModel = availableModels.find((model) => String(model?.id || "").trim() === defaultModelId);
        const defaults = {
          ...((config.defaultSettingsByProvider || {})[id] || config.defaultSettings || {}),
          ...(defaultModel?.defaults || {}),
          providerId: id,
          modelId: defaultModelId,
        };
        if (definition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;
        return {
          id,
          name,
          models: availableModels,
          adapter: definition?.adapter || "unknown",
          capabilities: definition?.capabilities || {},
          settingsSchema: Array.isArray(definition?.settingsSchema) ? definition.settingsSchema : [],
          defaults,
        };
      })
      .filter((provider) => provider.id && provider.name && provider.models.length);

    const desiredProviderId = String(config.defaultProviderId || "").trim();
    const defaultProviderId = (
      desiredProviderId && availableProviders.some((provider) => provider.id === desiredProviderId)
        ? desiredProviderId
        : availableProviders[0]?.id
    ) || "";
    const defaultModelId = defaultProviderId ? resolveDefaultModelId(defaultProviderId) : "";
    const definition = providers.getProviderDefinition(defaultProviderId);
    const defaultModel = models.listModelsForProvider(defaultProviderId)
      .filter((model) => isModelAllowed(defaultProviderId, model.id))
      .find((model) => String(model?.id || "").trim() === defaultModelId);
    const defaults = {
      ...((config.defaultSettingsByProvider || {})[defaultProviderId] || config.defaultSettings || {}),
      ...(defaultModel?.defaults || {}),
      providerId: defaultProviderId,
      modelId: defaultModelId,
    };
    if (definition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;
    return { providers: availableProviders, defaults };
  };
}

module.exports = { createGetChatMetaUseCase };
