function normalizePresetId(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized || !/^[a-zA-Z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}

function getControlDefaultValue(control, model) {
  const key = String(control?.key || "").trim();
  const modelDefaults = model?.defaults && typeof model.defaults === "object" && !Array.isArray(model.defaults)
    ? model.defaults
    : {};
  if (key && Object.prototype.hasOwnProperty.call(modelDefaults, key)) return modelDefaults[key];
  return control?.default;
}

function createChatSettingsService({ config, presetRepository, providers, models, schema, isModelAllowed } = {}) {
  if (!config || typeof config !== "object") throw new Error("Chat settings config is required");
  if (!presetRepository?.getPreset) throw new Error("Chat preset repository is required");
  if (!providers?.getProviderDefinition || !providers?.isSupportedProvider) {
    throw new Error("Chat provider catalog is required");
  }
  if (!models?.isSupportedModel || !models?.listModelsForProvider) throw new Error("Chat model catalog is required");
  if (!schema?.validateSettingsWithSchema) throw new Error("Chat settings schema is required");
  if (typeof isModelAllowed !== "function") throw new Error("Chat production model policy is required");

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: String(config.dayTimeZone).trim(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function formatLocalDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
      const parts = dayFormatter.formatToParts(date);
      const part = (type) => parts.find((entry) => entry.type === type)?.value;
      if (part("year") && part("month") && part("day")) return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      // Fall through to the process-local date when Intl rejects a supplied value.
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isSessionEditableToday(session) {
    const title = String(session?.title || "").trim();
    const fallbackRaw = session?.createdAt || session?.created_at || session?.updatedAt || session?.updated_at;
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(title) ? title : formatLocalDateKey(fallbackRaw) || title;
    return Boolean(dateKey) && dateKey === formatLocalDateKey(new Date());
  }

  function getSessionPresetId(session) {
    return (
      normalizePresetId(session?.preset_id || session?.presetId) ||
      normalizePresetId(session?.settings?.systemPromptPresetId) ||
      null
    );
  }

  function getDefaultPresetId() {
    return normalizePresetId(config.defaultSettings?.systemPromptPresetId) || "default";
  }

  async function resolvePresetForSession({
    userId,
    session,
    incomingSettings,
    explicitPresetId,
    enforceMatch = false,
  } = {}) {
    const sessionPresetId = session ? getSessionPresetId(session) : null;
    const hasIncomingPresetId = incomingSettings
      && Object.prototype.hasOwnProperty.call(incomingSettings, "systemPromptPresetId");
    const hasExplicitPresetId = explicitPresetId !== undefined;

    let requestedPresetId = null;
    if (hasExplicitPresetId) {
      requestedPresetId = normalizePresetId(explicitPresetId);
      if (!requestedPresetId) return { error: "Invalid preset id" };
    } else if (hasIncomingPresetId) {
      requestedPresetId = normalizePresetId(incomingSettings.systemPromptPresetId);
      if (!requestedPresetId) return { error: "Invalid preset id" };
    }

    if (enforceMatch && sessionPresetId) {
      if (requestedPresetId && requestedPresetId !== sessionPresetId) return { error: "Preset mismatch" };
      requestedPresetId = sessionPresetId;
    }

    const desiredPresetId = requestedPresetId || sessionPresetId || getDefaultPresetId();
    if (!desiredPresetId) return { error: "Invalid preset id" };

    const preset = await presetRepository.getPreset(userId, desiredPresetId);
    if (!preset) return { error: "Preset not found" };
    return { presetId: preset.id, preset, fallback: false };
  }

  function sanitize(rawSettings) {
    if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) return {};
    const sanitized = {};
    if (typeof rawSettings.providerId === "string") sanitized.providerId = rawSettings.providerId.trim();
    if (typeof rawSettings.modelId === "string") sanitized.modelId = rawSettings.modelId.trim();
    if (typeof rawSettings.systemPrompt === "string") sanitized.systemPrompt = rawSettings.systemPrompt;
    if (typeof rawSettings.systemPromptPresetId === "string") {
      sanitized.systemPromptPresetId = rawSettings.systemPromptPresetId.trim();
    }

    for (const key of ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty"]) {
      const value = Number(rawSettings[key]);
      if (Number.isFinite(value)) sanitized[key] = value;
    }
    if (typeof rawSettings.enableWebSearch === "boolean") sanitized.enableWebSearch = rawSettings.enableWebSearch;
    if (typeof rawSettings.stream === "boolean") sanitized.stream = rawSettings.stream;

    const providerId = String(sanitized.providerId || "").trim();
    const modelId = String(sanitized.modelId || "").trim();
    const controls = providerId ? schema.getActiveSchemaControls(providerId, modelId) : [];
    for (const control of controls) {
      const key = String(control?.key || "").trim();
      if (!key || Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
      if (modelId && Array.isArray(control?.modelBlocklist) && control.modelBlocklist.includes(modelId)) continue;
      const type = String(control?.type || "").trim();
      if (type === "toggle" && typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
      if (type === "select" && typeof rawSettings[key] === "string" && rawSettings[key].trim()) {
        sanitized[key] = rawSettings[key].trim();
      }
      if (type === "range" || type === "number") {
        const value = Number(rawSettings[key]);
        if (Number.isFinite(value)) sanitized[key] = value;
      }
    }
    return sanitized;
  }

  function normalize(settings, { providerId, modelId } = {}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
    const normalized = { ...settings };
    for (const key of ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty", "thinkingBudget"]) {
      if (normalized[key] === undefined) continue;
      const range = providerId ? schema.getProviderNumericRange(providerId, key) : null;
      const nextValue = schema.clampNumberWithRange(normalized[key], range || schema.getGlobalNumericRange(key));
      if (!Number.isFinite(nextValue)) {
        delete normalized[key];
      } else {
        normalized[key] = key === "maxOutputTokens" || key === "thinkingBudget" ? Math.trunc(nextValue) : nextValue;
      }
    }

    const activeControls = providerId ? schema.getActiveSchemaControls(providerId, modelId) : [];
    const activeKeys = new Set(activeControls.map((control) => String(control?.key || "").trim()).filter(Boolean));
    const providerSchema = providerId ? providers.getProviderDefinition(providerId)?.settingsSchema : [];
    for (const control of Array.isArray(providerSchema) ? providerSchema : []) {
      const key = String(control?.key || "").trim();
      if (key && !activeKeys.has(key)) delete normalized[key];
    }

    const model = schema.getProviderModel(providerId, modelId);
    for (const control of activeControls) {
      const key = String(control?.key || "").trim();
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
        const defaultValue = getControlDefaultValue(control, model);
        if (defaultValue !== undefined) normalized[key] = defaultValue;
      }
      const type = String(control?.type || "").trim();
      if (type === "toggle" && typeof normalized[key] !== "boolean") delete normalized[key];
      if (type === "select") {
        const value = String(normalized[key] || "").trim();
        const allowed = new Set(schema.getControlOptions(control, { model }).map((option) => String(option?.value ?? "").trim()));
        if (!value || !allowed.has(value)) delete normalized[key];
        else normalized[key] = value;
      }
    }
    return normalized;
  }

  function resolveProviderModel(settings) {
    const candidateProviderId = String(settings?.providerId || config.defaultProviderId || "").trim();
    if (!providers.isSupportedProvider(candidateProviderId)) {
      return { status: 400, error: `Unsupported provider: ${candidateProviderId}` };
    }
    const providerId = candidateProviderId;
    const providerDefinition = providers.getProviderDefinition(providerId);
    const configuredDefaultModelId = config.defaultModelByProvider?.[providerId];
    const selectableModels = models.listModelsForProvider(providerId).filter((model) => isModelAllowed(providerId, model.id));
    const fallbackModelId = selectableModels[0]?.id || "";
    const defaultModelId = (
      typeof configuredDefaultModelId === "string"
      && models.isSupportedModel(providerId, configuredDefaultModelId)
      && isModelAllowed(providerId, configuredDefaultModelId)
        ? configuredDefaultModelId.trim()
        : fallbackModelId
    ) || "";
    if (!defaultModelId) return { status: 500, error: `Missing model definitions for provider: ${providerId}` };

    const requestedModelId = String(settings?.modelId || "").trim();
    if (requestedModelId && !models.isSupportedModel(providerId, requestedModelId)) {
      return { status: 400, error: `Unsupported model for provider ${providerId}: ${requestedModelId}` };
    }
    if (requestedModelId && !isModelAllowed(providerId, requestedModelId)) {
      return { status: 400, error: `Model is not approved for production context capacity: ${providerId}/${requestedModelId}` };
    }
    return { providerId, providerDefinition, modelId: requestedModelId || defaultModelId };
  }

  function merge(baseSettings, overrideSettings) {
    const base = baseSettings && typeof baseSettings === "object" && !Array.isArray(baseSettings) ? baseSettings : {};
    const override = overrideSettings && typeof overrideSettings === "object" && !Array.isArray(overrideSettings)
      ? overrideSettings
      : {};
    return { ...base, ...override };
  }

  return Object.freeze({
    getDefaultPresetId,
    getSessionPresetId,
    isSessionEditableToday,
    merge,
    normalize,
    normalizePresetId,
    resolvePresetForSession,
    resolveProviderModel,
    sanitize,
    validate: (settings, options) => schema.validateSettingsWithSchema(settings, options),
  });
}

module.exports = { createChatSettingsService, normalizePresetId };
