const chatModel = require("@models/chatModel");
const chatPresetModel = require("@models/chatPresetModel");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { chatConfig, llmConfig, chatMemoryConfig, chatRagConfig, memoryV2Config } = require("../config");
const { compileChatContextMessages } = require("../services/chat/contextCompiler");
const { markRecoveryNotificationsDelivered } = require("../modules/memory");
const { buildRecentWindowContext } = require("../services/chat/context/buildRecentWindowContext");
const {
  getPresetMemoryStatus,
  markPresetMemoryDirty,
  clearPresetCoreMemory,
  rebuildRollingSummarySync,
  requestMemoryTick,
} = require("../services/chat/memory/writePipeline");
const { requestAssistantGistGeneration } = require("../services/chat/memory/gistPipeline");
const {
  requestChatTurnIndexing,
  requestDeleteChunksFromMessageId,
} = require("../services/chat/rag/indexer");
const { logger, withRequestContext } = require("../logger");
const {
  getProviderDefinition,
  isSupportedProvider,
  listConfiguredProviders,
  listSupportedProviders,
} = require("../services/llm/providers");
const { isSupportedModel, listModelsForProvider } = require("../services/llm/models");
const {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
} = require("../services/llm/chatCompletions");
const {
  getGlobalNumericRange,
  getProviderNumericRange,
  clampNumberWithRange,
  getActiveSchemaControls,
  getProviderModel,
  getControlOptions,
  validateSettingsWithSchema,
} = require("../services/llm/settingsSchema");

const CHAT_DAY_TIME_ZONE = String(chatConfig.dayTimeZone).trim();

let chatDayFormatter = null;
function getChatDayFormatter() {
  if (chatDayFormatter) return chatDayFormatter;
  chatDayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CHAT_DAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return chatDayFormatter;
}

function parseSessionId(rawValue) {
  const asNumber = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function parseMessageId(rawValue) {
  const asNumber = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function formatLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = getChatDayFormatter().formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // ignore
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSessionDateKey(session) {
  const title = String(session?.title || "").trim();
  if (isDateKey(title)) return title;

  const fallbackRaw = session?.createdAt || session?.created_at || session?.updatedAt || session?.updated_at;
  const fallback = formatLocalDateKey(fallbackRaw);
  return fallback || title;
}

function isSessionEditableToday(session) {
  const dateKey = getSessionDateKey(session);
  if (!dateKey) return false;
  return dateKey === formatLocalDateKey(new Date());
}

function normalizePresetId(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}

function getSessionPresetId(session) {
  return (
    normalizePresetId(session?.preset_id || session?.presetId) ||
    normalizePresetId(session?.settings?.systemPromptPresetId) ||
    null
  );
}

function getDefaultPresetId() {
  return normalizePresetId(chatConfig.defaultSettings?.systemPromptPresetId) || "default";
}

async function resolvePresetForSession({
  userId,
  session,
  incomingSettings,
  explicitPresetId,
  enforceMatch = false,
} = {}) {
  const defaultPresetId = getDefaultPresetId();
  const sessionPresetId = session ? getSessionPresetId(session) : null;
  const hasIncomingPresetId =
    incomingSettings && Object.prototype.hasOwnProperty.call(incomingSettings, "systemPromptPresetId");
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
    if (requestedPresetId && requestedPresetId !== sessionPresetId) {
      return { error: "Preset mismatch" };
    }
    requestedPresetId = sessionPresetId;
  }

  const desiredPresetId = requestedPresetId || sessionPresetId || defaultPresetId;

  if (!desiredPresetId) return { error: "Invalid preset id" };

  let preset = await chatPresetModel.getPreset(userId, desiredPresetId);
  if (!preset) {
    return { error: "Preset not found" };
  }

  return { presetId: preset.id, preset, fallback: false };
}

function sanitizeChatSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) return {};

  const sanitized = {};

  if (typeof rawSettings.providerId === "string") sanitized.providerId = rawSettings.providerId.trim();
  if (typeof rawSettings.modelId === "string") sanitized.modelId = rawSettings.modelId.trim();
  if (typeof rawSettings.systemPrompt === "string") sanitized.systemPrompt = rawSettings.systemPrompt;
  if (typeof rawSettings.systemPromptPresetId === "string")
    sanitized.systemPromptPresetId = rawSettings.systemPromptPresetId.trim();

  const temperature = Number(rawSettings.temperature);
  if (Number.isFinite(temperature)) sanitized.temperature = temperature;

  const topP = Number(rawSettings.topP);
  if (Number.isFinite(topP)) sanitized.topP = topP;

  const maxOutputTokens = Number(rawSettings.maxOutputTokens);
  if (Number.isFinite(maxOutputTokens)) sanitized.maxOutputTokens = maxOutputTokens;

  const presencePenalty = Number(rawSettings.presencePenalty);
  if (Number.isFinite(presencePenalty)) sanitized.presencePenalty = presencePenalty;

  const frequencyPenalty = Number(rawSettings.frequencyPenalty);
  if (Number.isFinite(frequencyPenalty)) sanitized.frequencyPenalty = frequencyPenalty;

  if (typeof rawSettings.enableWebSearch === "boolean") sanitized.enableWebSearch = rawSettings.enableWebSearch;
  if (typeof rawSettings.stream === "boolean") sanitized.stream = rawSettings.stream;

  const providerId = String(sanitized.providerId || "").trim();
  const modelId = String(sanitized.modelId || "").trim();
  const schema = providerId ? getActiveSchemaControls(providerId, modelId) : [];

  for (const control of schema) {
    const key = typeof control?.key === "string" ? control.key.trim() : "";
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) continue;

    const blocklist = Array.isArray(control?.modelBlocklist) ? control.modelBlocklist : [];
    if (modelId && blocklist.includes(modelId)) continue;

    const type = String(control?.type || "").trim();

    if (type === "toggle") {
      if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
      continue;
    }

    if (type === "select") {
      if (typeof rawSettings[key] !== "string") continue;
      const value = rawSettings[key].trim();
      if (!value) continue;

      sanitized[key] = value;
      continue;
    }

    if (type === "range" || type === "number") {
      const number = Number(rawSettings[key]);
      if (Number.isFinite(number)) sanitized[key] = number;
    }
  }

  return sanitized;
}

function getControlDefaultValue(control, model) {
  const key = String(control?.key || "").trim();
  const modelDefaults = model?.defaults && typeof model.defaults === "object" && !Array.isArray(model.defaults)
    ? model.defaults
    : {};
  if (key && Object.prototype.hasOwnProperty.call(modelDefaults, key)) return modelDefaults[key];
  return control?.default;
}

function normalizeChatSettingsWithSchema(settings, { providerId, modelId } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};

  const normalized = { ...settings };
  const keys = ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty", "thinkingBudget"];

  for (const key of keys) {
    if (normalized[key] === undefined) continue;

    const range = providerId ? getProviderNumericRange(providerId, key) : null;
    const fallbackRange = getGlobalNumericRange(key);
    const nextValue = clampNumberWithRange(normalized[key], range || fallbackRange);

    if (!Number.isFinite(nextValue)) {
      delete normalized[key];
      continue;
    }

    if (key === "maxOutputTokens" || key === "thinkingBudget") {
      normalized[key] = Math.trunc(nextValue);
    } else {
      normalized[key] = nextValue;
    }
  }

  const activeControls = providerId ? getActiveSchemaControls(providerId, modelId) : [];
  const activeKeys = new Set(activeControls.map((control) => String(control?.key || "").trim()).filter(Boolean));
  const providerSchema = providerId ? getProviderDefinition(providerId)?.settingsSchema : [];
  const schemaKeys = new Set(
    (Array.isArray(providerSchema) ? providerSchema : []).map((control) => String(control?.key || "").trim()).filter(Boolean)
  );
  for (const key of schemaKeys) {
    if (!activeKeys.has(key)) delete normalized[key];
  }

  const model = getProviderModel(providerId, modelId);
  for (const control of activeControls) {
    const key = String(control?.key || "").trim();
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      const defaultValue = getControlDefaultValue(control, model);
      if (defaultValue === undefined) continue;
      normalized[key] = defaultValue;
    }

    const type = String(control?.type || "").trim();
    if (type === "toggle") {
      if (typeof normalized[key] !== "boolean") delete normalized[key];
      continue;
    }

    if (type === "select") {
      const value = String(normalized[key] || "").trim();
      const allowed = new Set(getControlOptions(control, { model }).map((option) => String(option?.value ?? "").trim()));
      if (!value || !allowed.has(value)) {
        delete normalized[key];
        continue;
      }
      normalized[key] = value;
    }
  }

  return normalized;
}

function resolveProviderModelForSettings(settings) {
  const defaultProviderId = chatConfig.defaultProviderId;
  const candidateProviderId = String(settings?.providerId || defaultProviderId || "").trim();
  if (!isSupportedProvider(candidateProviderId)) {
    return { status: 400, error: `Unsupported provider: ${candidateProviderId}` };
  }

  const providerId = candidateProviderId;
  const providerDefinition = getProviderDefinition(providerId);
  const configuredDefaultModelId = chatConfig.defaultModelByProvider?.[providerId];
  const fallbackModelId = listModelsForProvider(providerId)[0]?.id || "";
  const defaultModelId =
    (typeof configuredDefaultModelId === "string" && isSupportedModel(providerId, configuredDefaultModelId)
      ? configuredDefaultModelId.trim()
      : fallbackModelId) || "";

  if (!defaultModelId) {
    return { status: 500, error: `Missing model definitions for provider: ${providerId}` };
  }

  const requestedModelId = String(settings?.modelId || "").trim();
  if (requestedModelId && !isSupportedModel(providerId, requestedModelId)) {
    return { status: 400, error: `Unsupported model for provider ${providerId}: ${requestedModelId}` };
  }

  return {
    providerId,
    providerDefinition,
    modelId: requestedModelId || defaultModelId,
  };
}

function validateResolvedSettings(settings, { providerId, modelId } = {}) {
  return validateSettingsWithSchema(settings, { providerId, modelId });
}

function mergeSettings(baseSettings, overrideSettings) {
  const base = baseSettings && typeof baseSettings === "object" && !Array.isArray(baseSettings) ? baseSettings : {};
  const override =
    overrideSettings && typeof overrideSettings === "object" && !Array.isArray(overrideSettings)
      ? overrideSettings
      : {};
  return { ...base, ...override };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getAbortReasonMessage(signal) {
  const reason = signal?.reason;
  if (!reason) return "";
  if (reason instanceof Error) return reason.message || "";
  return String(reason);
}

async function isChatMemoryLocked({ userId, presetId } = {}) {
  try {
    const memory = await getPresetMemoryStatus({ userId, presetId });
    return Boolean(memory?.rebuildRequired);
  } catch (error) {
    if (error?.code === "42P01") return false;
    throw error;
  }
}

async function isPresetHistoryLongerThanRecentWindow({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return false;

  const recentWindow = await buildRecentWindowContext({ userId: normalizedUserId, presetId: normalizedPresetId });
  return Boolean(recentWindow?.needsMemory);
}

async function lockAndRebuildChatMemoryAsync({ userId, presetId, sinceMessageId, reason } = {}) {
  if (!chatMemoryConfig.legacyEnabled) return;

  let existing = null;
  try {
    existing = await getPresetMemoryStatus({ userId, presetId });
  } catch (error) {
    if (error?.code === "42P01") return;
    throw error;
  }

  let needsMemory = false;
  try {
    needsMemory = await isPresetHistoryLongerThanRecentWindow({ userId, presetId });
  } catch (error) {
    logger.error("chat_memory_needs_check_failed", { error, userId, presetId });
    needsMemory = false;
  }

  if (!existing && !needsMemory) return;

  try {
    await markPresetMemoryDirty({ userId, presetId, sinceMessageId, rebuildRequired: needsMemory, reason });
  } catch (error) {
    if (error?.code !== "42P01") throw error;
    return;
  }

  if (!needsMemory) return;

  void rebuildRollingSummarySync({ userId, presetId }).catch((error) => {
    logger.error("chat_memory_rebuild_failed", {
      error,
      userId,
      presetId,
      providerId: chatMemoryConfig.workerProviderId,
      modelId: chatMemoryConfig.workerModelId,
    });
    logger.error("chat_memory_rebuild_hard_lock_retained", {
      userId,
      presetId,
      reason: "hard_no_fallback_unlock_enabled",
      note: "rebuildRequired lock is intentionally retained; chat remains blocked with 423 until rebuild succeeds or is manually released",
    });
  });
}

function kickMemoryUpdate({ userId, presetId, needsMemory } = {}) {
  if (!chatMemoryConfig.legacyEnabled || !needsMemory) return;
  try {
    requestMemoryTick({ userId, presetId });
  } catch (error) {
    logger.error("chat_memory_tick_kick_failed", { error, userId, presetId });
  }
}

function getRagSources(context) {
  const sources = Array.isArray(context?.rag?.sources) ? context.rag.sources : [];
  return sources.filter(Boolean);
}

function getRagDebug(context) {
  if (!chatRagConfig.enabled || !chatRagConfig.debugIncludeContent) return null;
  const rag = context?.rag;
  if (!rag) return null;

  return {
    enabled: Boolean(rag.enabled),
    stats: rag.stats || null,
    sources: getRagSources(context),
  };
}

function attachRagSources(message, context) {
  const sources = getRagSources(context);
  const debug = getRagDebug(context);
  if (!message || (!sources.length && !debug)) return message;

  const next = { ...message };
  if (sources.length) next.rag_sources = sources;
  if (debug) next.rag_debug = debug;
  return next;
}

function attachContextHealth(payload, context, res) {
  const notifications = Array.isArray(context?.memoryRecoveryNotifications) ? context.memoryRecoveryNotifications : [];
  const next = { ...payload };
  if (context?.memoryHealth) next.memory_health = context.memoryHealth;
  if (notifications.length) next.memory_recovery_notifications = notifications;
  const ids = notifications.map((entry) => Number(entry.id)).filter(Number.isSafeInteger);
  if (ids.length) {
    res.once("finish", () => {
      void markRecoveryNotificationsDelivered(ids).catch((error) => logger.warn("memory_recovery_notification_delivery_mark_failed", { error, ids }));
    });
  }
  return next;
}

function kickRagTurnIndexing({ userId, presetId, sessionId, userMessage, assistantMessage, userContent, assistantContent } = {}) {
  try {
    requestChatTurnIndexing({
      userId,
      presetId,
      sessionId,
      userMessage,
      assistantMessage,
      userContent,
      assistantContent,
    });
  } catch (error) {
    logger.error("chat_rag_turn_index_kick_failed", {
      error,
      userId,
      presetId,
      sessionId,
      userMessageId: userMessage?.id,
      assistantMessageId: assistantMessage?.id,
    });
  }
}

function kickRagDeleteFromMessage({ userId, presetId, fromMessageId } = {}) {
  try {
    requestDeleteChunksFromMessageId({ userId, presetId, fromMessageId });
  } catch (error) {
    logger.error("chat_rag_delete_kick_failed", { error, userId, presetId, fromMessageId });
  }
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}

async function compressAvatarImage({ inputPath, baseName }) {
  const dir = path.dirname(inputPath);
  const outputFilename = `${baseName}-compressed.webp`;
  const outputPath = path.join(dir, outputFilename);

  await sharp(inputPath).rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toFile(outputPath);

  await safeUnlink(inputPath);
  return { filename: outputFilename, path: outputPath };
}

const chatController = {
  async getMeta(req, res) {
    try {
      const configuredProviders = listConfiguredProviders();
      const baseProviders = configuredProviders.length ? configuredProviders : listSupportedProviders();

      function resolveDefaultModelId(providerId) {
        const configuredDefaultModelId = chatConfig.defaultModelByProvider?.[providerId];
        const fallbackModelId = listModelsForProvider(providerId)[0]?.id || "";
        const defaultModelId =
          (typeof configuredDefaultModelId === "string" && isSupportedModel(providerId, configuredDefaultModelId)
            ? configuredDefaultModelId.trim()
            : fallbackModelId) || "";
        return defaultModelId;
      }

      const providers = baseProviders
        .map((provider) => {
          const id = String(provider?.id || "").trim();
          const name = String(provider?.name || "").trim();
          const models = listModelsForProvider(id);
          const definition = getProviderDefinition(id);

          const defaultModelId = resolveDefaultModelId(id);
          const defaultModelEntry = models.find((m) => String(m?.id || "").trim() === defaultModelId);
          const defaults = {
            ...((chatConfig.defaultSettingsByProvider || {})[id] || chatConfig.defaultSettings || {}),
            ...(defaultModelEntry?.defaults || {}),
            providerId: id,
            modelId: defaultModelId,
          };
          if (definition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;

          return {
            id,
            name,
            models,
            adapter: definition?.adapter || "unknown",
            capabilities: definition?.capabilities || {},
            settingsSchema: Array.isArray(definition?.settingsSchema) ? definition.settingsSchema : [],
            defaults,
          };
        })
        .filter((provider) => provider.id && provider.name && Array.isArray(provider.models) && provider.models.length);

      const fallbackProviderId = providers[0]?.id || "";
      const desiredProviderId = String(chatConfig.defaultProviderId || "").trim();
      const defaultProviderId =
        (desiredProviderId && providers.some((provider) => provider.id === desiredProviderId)
          ? desiredProviderId
          : fallbackProviderId) || "";

      let defaultModelId = "";
      if (defaultProviderId) {
        const desiredModelId = chatConfig.defaultModelByProvider?.[defaultProviderId];
        if (typeof desiredModelId === "string" && isSupportedModel(defaultProviderId, desiredModelId)) {
          defaultModelId = desiredModelId.trim();
        } else {
          defaultModelId = providers.find((provider) => provider.id === defaultProviderId)?.models?.[0]?.id || "";
        }
      }

      const selectedProviderDefinition = getProviderDefinition(defaultProviderId);
      const defaultProviderModels = listModelsForProvider(defaultProviderId);
      const defaultModelEntry = defaultProviderModels.find((m) => String(m?.id || "").trim() === defaultModelId);
      const defaults = {
        ...((chatConfig.defaultSettingsByProvider || {})[defaultProviderId] || chatConfig.defaultSettings || {}),
        ...(defaultModelEntry?.defaults || {}),
        providerId: defaultProviderId,
        modelId: defaultModelId,
      };
      if (selectedProviderDefinition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;

      res.status(200).json({ providers, defaults });
    } catch (error) {
      logger.error("chat_meta_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listPresets(req, res) {
    try {
      const userId = req.user?.id;
      const presets = await chatPresetModel.listPresets(userId);
      res.status(200).json({ presets });
    } catch (error) {
      logger.error("chat_preset_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listTrashedPresets(req, res) {
    try {
      const userId = req.user?.id;
      const presets = await chatPresetModel.listTrashedPresets(userId);
      res.status(200).json({ presets });
    } catch (error) {
      logger.error("chat_preset_trash_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createPreset(req, res) {
    try {
      const userId = req.user?.id;

      const presetId = normalizePresetId(req.body?.id);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset id is reserved" });
      }

      const name = String(req.body?.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "Preset name cannot be empty" });

      const systemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : "";

      const preset = await chatPresetModel.createPreset(userId, {
        id: presetId,
        name,
        systemPrompt,
        avatarUrl: null,
      });

      res.status(201).json({ preset });
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Preset id already exists" });
      }
      logger.error("chat_preset_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async updatePreset(req, res) {
    try {
      const userId = req.user?.id;
      const currentId = normalizePresetId(req.params.presetId);
      if (!currentId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(currentId)) {
        return res.status(400).json({ error: "Builtin preset cannot be updated" });
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, "id")) {
        return res.status(400).json({ error: "Preset id cannot be updated" });
      }

      let nextName = undefined;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) {
        nextName = String(req.body?.name ?? "").trim();
        if (!nextName) return res.status(400).json({ error: "Preset name cannot be empty" });
      }

      let nextSystemPrompt = undefined;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "systemPrompt")) {
        nextSystemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : "";
      }

      const preset = await chatPresetModel.updatePreset(userId, currentId, {
        name: nextName,
        systemPrompt: nextSystemPrompt,
      });
      if (!preset) return res.status(404).json({ error: "Preset not found" });

      res.status(200).json({ preset });
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Preset id already exists" });
      }
      if (error?.code === "BUILTIN_PRESET_ID" || error?.code === "BUILTIN_PRESET_READONLY") {
        return res.status(400).json({ error: error.message });
      }
      logger.error("chat_preset_update_failed", withRequestContext(req, { error, presetId: req.params.presetId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async rebuildPresetMemory(req, res) {
    try {
      if (!chatMemoryConfig.legacyEnabled) {
        return res.status(410).json({ error: "Legacy memory rebuild is no longer available" });
      }

      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });

      const preset = await chatPresetModel.getPreset(userId, presetId);
      if (!preset) return res.status(404).json({ error: "Preset not found" });

      await markPresetMemoryDirty({
        userId,
        presetId: preset.id,
        sinceMessageId: 0,
        rebuildRequired: true,
        reason: "manual_rebuild",
      });

      const logContext = withRequestContext(req, {
        userId,
        presetId: preset.id,
        providerId: chatMemoryConfig.workerProviderId,
        modelId: chatMemoryConfig.workerModelId,
      });

      void rebuildRollingSummarySync({ userId, presetId: preset.id })
        .then((result) => {
          logger.info("chat_memory_manual_rebuild_completed", {
            ...logContext,
            updated: Boolean(result?.updated),
            reason: result?.reason,
            needsMemory: Boolean(result?.needsMemory),
            processedBatches: result?.processedBatches,
            processedMessages: result?.processedMessages,
          });
        })
        .catch((error) => {
          logger.error("chat_memory_manual_rebuild_failed", { ...logContext, error });
          logger.error("chat_memory_rebuild_hard_lock_retained", {
            ...logContext,
            reason: "manual_rebuild_failed",
            note: "rebuildRequired lock is intentionally retained; chat remains blocked with 423 until rebuild succeeds or is manually released",
          });
        });

      res.status(202).json({
        presetId: preset.id,
        memory: {
          status: "queued",
          rebuildRequired: true,
        },
      });
    } catch (error) {
      if (error?.code === "42P01") {
        return res.status(500).json({ error: "Chat memory table is not initialized" });
      }
      logger.error("chat_preset_memory_rebuild_failed", withRequestContext(req, { error, presetId: req.params.presetId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deletePreset(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot be deleted" });
      }

      const result = await chatPresetModel.deletePreset(userId, presetId);
      if (!result.deleted) return res.status(404).json({ error: "Preset not found" });

      res.status(204).send();
    } catch (error) {
      logger.error("chat_preset_delete_failed", withRequestContext(req, { error, presetId: req.params.presetId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async restorePreset(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot be restored" });
      }

      const preset = await chatPresetModel.restorePreset(userId, presetId);
      if (!preset) return res.status(404).json({ error: "Preset not found" });

      res.status(200).json({ preset });
    } catch (error) {
      logger.error("chat_preset_restore_failed", withRequestContext(req, { error, presetId: req.params.presetId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deletePresetPermanently(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot be deleted" });
      }

      const deleted = await chatPresetModel.deletePresetPermanently(userId, presetId);
      if (!deleted) return res.status(404).json({ error: "Preset not found" });

      res.status(204).send();
    } catch (error) {
      logger.error(
        "chat_preset_delete_permanent_failed",
        withRequestContext(req, { error, presetId: req.params.presetId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async uploadPresetAvatar(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot upload avatar" });
      }

      if (!req.file) return res.status(400).json({ error: "Missing avatar file" });

      const existingPreset = await chatPresetModel.getPreset(userId, presetId);
      if (!existingPreset || existingPreset.isBuiltin) {
        await safeUnlink(req.file.path);
        return res.status(404).json({ error: "Preset not found" });
      }

      const baseName = path.parse(req.file.filename).name;
      let processed;
      try {
        processed = await compressAvatarImage({ inputPath: req.file.path, baseName });
      } catch (processError) {
        await safeUnlink(req.file.path);
        return res.status(400).json({ error: "Avatar processing failed" });
      }

      const avatarUrl = `/uploads/assistant_avatars/${processed.filename}`;
      let preset;
      try {
        preset = await chatPresetModel.updatePresetAvatar(userId, presetId, avatarUrl);
      } catch (updateError) {
        await safeUnlink(processed.path);
        throw updateError;
      }
      if (!preset) {
        await safeUnlink(processed.path);
        return res.status(404).json({ error: "Preset not found" });
      }

      res.status(200).json({ preset });
    } catch (error) {
      logger.error(
        "chat_preset_avatar_upload_failed",
        withRequestContext(req, { error, presetId: req.params.presetId })
      );
      res.status(500).json({ error: error?.message || "Internal Server Error" });
    }
  },

  async listSessions(req, res) {
    try {
      const userId = req.user?.id;
      const sessions = await chatModel.listSessions(userId);
      res.status(200).json({ sessions });
    } catch (error) {
      logger.error("chat_session_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listTrashedSessions(req, res) {
    try {
      const userId = req.user?.id;
      const sessions = await chatModel.listTrashedSessions(userId);
      res.status(200).json({ sessions });
    } catch (error) {
      logger.error("chat_session_trash_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createSession(req, res) {
    try {
      const userId = req.user?.id;
      const rawSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({
        userId,
        incomingSettings: rawSettings,
        explicitPresetId: req.body?.presetId,
      });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      let settings = {
        ...rawSettings,
        systemPromptPresetId: presetId,
        systemPrompt: preset?.systemPrompt || "",
      };
      const providerResolution = resolveProviderModelForSettings(settings);
      if (providerResolution.error) return res.status(providerResolution.status).json({ error: providerResolution.error });

      const { providerId, modelId, providerDefinition } = providerResolution;
      const validationError = validateResolvedSettings(settings, { providerId, modelId });
      if (validationError) return res.status(400).json({ error: validationError });

      settings = normalizeChatSettingsWithSchema(settings, { providerId, modelId });
      settings.providerId = providerId;
      settings.modelId = modelId;
      settings.systemPromptPresetId = presetId;
      settings.systemPrompt = preset?.systemPrompt || "";
      if (providerDefinition?.capabilities?.webSearch === false) settings.enableWebSearch = false;

      const title = req.body?.title;
      const session = await chatModel.createSession(userId, { title, settings, presetId });
      res.status(201).json({ session });
    } catch (error) {
      logger.error("chat_session_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deleteSession(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const session = await chatModel.trashSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });

      const presetId = String(session?.preset_id || session?.presetId || "").trim();
      if (presetId) {
        try {
          let sinceMessageId = 0;
          try {
            const range = await chatModel.getSessionMessageIdRange(userId, sessionId);
            if (range?.minMessageId) sinceMessageId = range.minMessageId;
          } catch (rangeError) {
            logger.error("chat_session_message_range_failed", withRequestContext(req, { error: rangeError, sessionId, presetId }));
          }

          await lockAndRebuildChatMemoryAsync({ userId, presetId, sinceMessageId, reason: "session_trashed" });
        } catch (error) {
          logger.error("chat_memory_rebuild_trigger_failed", withRequestContext(req, { error, presetId, sessionId }));
        }
      }

      res.status(204).send();
    } catch (error) {
      logger.error("chat_session_delete_failed", withRequestContext(req, { error, sessionId: req.params.sessionId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async restoreSession(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const session = await chatModel.restoreSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });

      const presetId = String(session?.preset_id || session?.presetId || "").trim();
      if (presetId) {
        try {
          let sinceMessageId = 0;
          try {
            const range = await chatModel.getSessionMessageIdRange(userId, sessionId);
            if (range?.minMessageId) sinceMessageId = range.minMessageId;
          } catch (rangeError) {
            logger.error("chat_session_message_range_failed", withRequestContext(req, { error: rangeError, sessionId, presetId }));
          }

          await lockAndRebuildChatMemoryAsync({ userId, presetId, sinceMessageId, reason: "session_restored" });
        } catch (error) {
          logger.error("chat_memory_rebuild_trigger_failed", withRequestContext(req, { error, presetId, sessionId }));
        }
      }

      res.status(200).json({ session });
    } catch (error) {
      logger.error("chat_session_restore_failed", withRequestContext(req, { error, sessionId: req.params.sessionId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deleteSessionPermanently(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const deletedSession = await chatModel.deleteSessionPermanently(userId, sessionId);
      if (!deletedSession) return res.status(404).json({ error: "Session not found" });

      const presetId = String(deletedSession?.preset_id || deletedSession?.presetId || "").trim();
      if (presetId) {
        try {
          const sinceMessageId = Number(deletedSession?.firstMessageId) || 0;
          await lockAndRebuildChatMemoryAsync({
            userId,
            presetId,
            sinceMessageId,
            reason: "session_deleted_permanent",
          });
        } catch (error) {
          logger.error("chat_memory_rebuild_trigger_failed", withRequestContext(req, { error, presetId, sessionId }));
        }
      }

      res.status(204).send();
    } catch (error) {
      logger.error(
        "chat_session_delete_permanent_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listMessages(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const messages = await chatModel.listMessages(userId, sessionId);
      if (messages === null) return res.status(404).json({ error: "Session not found" });

      res.status(200).json({ messages });
    } catch (error) {
      logger.error("chat_messages_list_failed", withRequestContext(req, { error, sessionId: req.params.sessionId }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async editMessage(_req, res) {
    const req = _req;

    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const messageId = parseMessageId(req.params.messageId);
      if (!messageId) return res.status(400).json({ error: "Invalid messageId" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Content cannot be empty" });

      const regenerate = Boolean(req.body?.regenerate);
      const truncate = regenerate ? true : Boolean(req.body?.truncate);

      const session = await chatModel.getSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!isSessionEditableToday(session)) return res.status(403).json({ error: "Historical sessions are read-only" });

      const sessionPresetId = String(session?.preset_id || session?.presetId || "").trim();
      if (!memoryV2Config.enabled && sessionPresetId && (await isChatMemoryLocked({ userId, presetId: sessionPresetId }))) {
        return res.status(423).json({ error: "记忆重建中，请稍后再试", code: "CHAT_MEMORY_REBUILDING" });
      }

      const message = await chatModel.getMessage(userId, sessionId, messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      if (message.role !== "user") return res.status(400).json({ error: "Only user messages can be edited" });

      if (truncate) {
        await chatModel.deleteMessagesAfter(userId, sessionId, messageId);
      }

      const updatedUserMessage = await chatModel.updateMessageContent(userId, sessionId, messageId, content);
      if (!updatedUserMessage) return res.status(404).json({ error: "Message not found" });

      let updatedSession = session;

      const incomingSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      kickRagDeleteFromMessage({ userId, presetId, fromMessageId: messageId });

      const mergedSettings = mergeSettings(session.settings, incomingSettings);
      mergedSettings.systemPromptPresetId = presetId;
      mergedSettings.systemPrompt = preset?.systemPrompt || "";
      const providerResolution = resolveProviderModelForSettings(mergedSettings);
      if (providerResolution.error) return res.status(providerResolution.status).json({ error: providerResolution.error });

      const { providerId, modelId, providerDefinition } = providerResolution;
      const validationError = validateResolvedSettings(mergedSettings, { providerId, modelId });
      if (validationError) return res.status(400).json({ error: validationError });

      const effectiveSettings = normalizeChatSettingsWithSchema(mergedSettings, { providerId, modelId });
      effectiveSettings.providerId = providerId;
      effectiveSettings.modelId = modelId;
      effectiveSettings.systemPromptPresetId = presetId;
      effectiveSettings.systemPrompt = preset?.systemPrompt || "";
      if (providerDefinition?.capabilities?.webSearch === false) {
        effectiveSettings.enableWebSearch = false;
      }
      updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings, presetId)) || updatedSession;

      try {
        const existing = await getPresetMemoryStatus({ userId, presetId });
        if (existing) {
          const summarizedUntilMessageId = Number(existing?.summarizedUntilMessageId) || 0;
          const coreCoveredUntilMessageId = Number(existing?.coreMemory?.meta?.coveredUntilMessageId) || 0;

          if (summarizedUntilMessageId >= messageId) {
            await lockAndRebuildChatMemoryAsync({ userId, presetId, sinceMessageId: messageId, reason: "edit_truncate" });
          } else if (coreCoveredUntilMessageId >= messageId) {
            await clearPresetCoreMemory({ userId, presetId, sinceMessageId: messageId, reason: "edit_truncate" });
          }
        }
      } catch (error) {
        if (error?.code !== "42P01") throw error;
      }

      if (!regenerate) {
        updatedSession = (await chatModel.touchSession(userId, sessionId)) || updatedSession;
        return res.status(200).json({ session: updatedSession, user_message: updatedUserMessage });
      }

      const providerSettings = effectiveSettings;
      updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, providerSettings, presetId)) || updatedSession;

      const shouldStream = Boolean(providerSettings.stream);

      const context = await compileChatContextMessages({
        userId,
        presetId,
        systemPrompt: providerSettings.systemPrompt,
        upToMessageId: messageId,
      });
      const messages = context.messages;
      const needsMemory = Boolean(context.needsMemory);

      logger.debug(
        "chat_context_compiled",
        withRequestContext(req, {
          sessionId,
          presetId,
          segments: context.segments,
          memory: context.memory,
        })
      );
      logger.debugFull(
        "chat_api_request",
        withRequestContext(req, {
          sessionId,
          presetId,
          messageId,
          providerId,
          modelId,
          stream: shouldStream,
          messages,
        })
      );

      if (!shouldStream) {
        const { content: assistantContent } = await createChatCompletion({
          providerId,
          model: modelId,
          messages,
          settings: providerSettings,
        });

        const assistantMessage = await chatModel.createMessage(userId, sessionId, "assistant", assistantContent);
        updatedSession = await chatModel.touchSession(userId, sessionId);
        kickMemoryUpdate({ userId, presetId, needsMemory });
        kickRagTurnIndexing({
          userId,
          presetId,
          sessionId,
          userMessage: updatedUserMessage,
          assistantMessage,
          userContent: updatedUserMessage?.content,
          assistantContent,
        });
        requestAssistantGistGeneration({
          userId,
          presetId,
          messageId: assistantMessage?.id,
          userContent: updatedUserMessage?.content,
          content: assistantContent,
        });

        return res
          .status(200)
          .json(attachContextHealth({
            session: updatedSession,
            user_message: updatedUserMessage,
            assistant_message: attachRagSources(assistantMessage, context),
          }, context, res));
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      writeSse(res, { type: "start", session_id: sessionId, user_message: updatedUserMessage });

      const abortController = new AbortController();
      req.on("close", () => abortController.abort(new Error("Client disconnected")));
      const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), llmConfig.timeoutMs);

      let assistantContent = "";
      let finalAssistantContent = "";
      try {
        const upstreamResponse = await createChatCompletionStreamResponse({
          providerId,
          model: modelId,
          messages,
          settings: providerSettings,
          signal: abortController.signal,
        });

        for await (const event of streamChatCompletionDeltas({ providerId, response: upstreamResponse })) {
          if (typeof event === "string") {
            const delta = event;
            if (!delta) continue;
            assistantContent += delta;
            writeSse(res, { type: "delta", delta });
            continue;
          }

          if (!event || typeof event !== "object") continue;

          if (event.type === "final") {
            if (typeof event.content === "string" && event.content.trim()) {
              finalAssistantContent = event.content;
            }
            continue;
          }

          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) continue;
          assistantContent += delta;
          writeSse(res, { type: "delta", delta });
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          const message = getAbortReasonMessage(abortController.signal);
          if (message && message !== "Client disconnected") {
            writeSse(res, { type: "error", error: message });
          }
          res.end();
          return;
        }
        throw streamError;
      } finally {
        clearTimeout(timeout);
      }

      const normalizedAssistantContent = (finalAssistantContent || assistantContent).trim();
      if (!normalizedAssistantContent) {
        writeSse(res, { type: "error", error: "Empty model response" });
        res.end();
        return;
      }

      const assistantMessage = await chatModel.createMessage(
        userId,
        sessionId,
        "assistant",
        normalizedAssistantContent
      );
      updatedSession = await chatModel.touchSession(userId, sessionId);
      kickMemoryUpdate({ userId, presetId, needsMemory });
      kickRagTurnIndexing({
        userId,
        presetId,
        sessionId,
        userMessage: updatedUserMessage,
        assistantMessage,
        userContent: updatedUserMessage?.content,
        assistantContent: normalizedAssistantContent,
      });
      requestAssistantGistGeneration({
        userId,
        presetId,
        messageId: assistantMessage?.id,
        userContent: updatedUserMessage?.content,
        content: normalizedAssistantContent,
      });

      writeSse(res, attachContextHealth({
        type: "done",
        session: updatedSession,
        user_message: updatedUserMessage,
        assistant_message: attachRagSources(assistantMessage, context),
      }, context, res));
      res.end();
    } catch (error) {
      const message = error?.message || "Internal Server Error";
      if (res.headersSent && res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
        try {
          writeSse(res, { type: "error", error: message });
          res.end();
        } catch {
          // ignore
        }
        return;
      }

      logger.error(
        "chat_message_edit_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId, messageId: req.params.messageId })
      );
      res.status(500).json({ error: message });
    }
  },

  async sendMessage(_req, res) {
    const req = _req;
    let errorSession = null;
    let userMessage = null;

    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Content cannot be empty" });

      const session = await chatModel.getSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      errorSession = session;
      if (!isSessionEditableToday(session)) return res.status(403).json({ error: "Historical sessions are read-only" });

      const incomingSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      const mergedSettings = mergeSettings(session.settings, incomingSettings);
      mergedSettings.systemPromptPresetId = presetId;
      mergedSettings.systemPrompt = preset?.systemPrompt || "";

      const providerResolution = resolveProviderModelForSettings(mergedSettings);
      if (providerResolution.error) return res.status(providerResolution.status).json({ error: providerResolution.error });

      const { providerId, modelId, providerDefinition } = providerResolution;
      const validationError = validateResolvedSettings(mergedSettings, { providerId, modelId });
      if (validationError) return res.status(400).json({ error: validationError });

      const effectiveSettings = normalizeChatSettingsWithSchema(mergedSettings, { providerId, modelId });
      effectiveSettings.providerId = providerId;
      effectiveSettings.modelId = modelId;
      effectiveSettings.systemPromptPresetId = presetId;
      effectiveSettings.systemPrompt = preset?.systemPrompt || "";
      if (providerDefinition?.capabilities?.webSearch === false) {
        effectiveSettings.enableWebSearch = false;
      }

      const shouldStream = Boolean(effectiveSettings.stream);

      let updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings, presetId)) || session;
      errorSession = updatedSession;

      if (!memoryV2Config.enabled && (await isChatMemoryLocked({ userId, presetId }))) {
        return res.status(423).json({ error: "记忆重建中，请稍后再试", code: "CHAT_MEMORY_REBUILDING" });
      }

      userMessage = await chatModel.createMessage(userId, sessionId, "user", content);
      if (!userMessage) return res.status(404).json({ error: "Session not found" });

      const context = await compileChatContextMessages({
        userId,
        presetId,
        systemPrompt: effectiveSettings.systemPrompt,
        upToMessageId: userMessage.id,
      });
      const messages = context.messages;
      const needsMemory = Boolean(context.needsMemory);

      logger.debug(
        "chat_context_compiled",
        withRequestContext(req, {
          sessionId,
          presetId,
          segments: context.segments,
          memory: context.memory,
        })
      );
      logger.debugFull(
        "chat_api_request",
        withRequestContext(req, {
          sessionId,
          presetId,
          messageId: userMessage?.id,
          providerId,
          modelId,
          stream: shouldStream,
          messages,
        })
      );

      if (!shouldStream) {
        const { content: assistantContent } = await createChatCompletion({
          providerId,
          model: modelId,
          messages,
          settings: effectiveSettings,
        });

        const assistantMessage = await chatModel.createMessage(userId, sessionId, "assistant", assistantContent);
        updatedSession = await chatModel.touchSession(userId, sessionId);
        errorSession = updatedSession;
        kickMemoryUpdate({ userId, presetId, needsMemory });
        kickRagTurnIndexing({
          userId,
          presetId,
          sessionId,
          userMessage,
          assistantMessage,
          userContent: userMessage?.content,
          assistantContent,
        });
        requestAssistantGistGeneration({
          userId,
          presetId,
          messageId: assistantMessage?.id,
          userContent: userMessage?.content,
          content: assistantContent,
        });

        return res
          .status(200)
          .json(attachContextHealth({
            session: updatedSession,
            user_message: userMessage,
            assistant_message: attachRagSources(assistantMessage, context),
          }, context, res));
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      writeSse(res, { type: "start", session_id: sessionId, user_message: userMessage });

      const abortController = new AbortController();
      req.on("close", () => abortController.abort(new Error("Client disconnected")));
      const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), llmConfig.timeoutMs);

      let assistantContent = "";
      let finalAssistantContent = "";
      try {
        const upstreamResponse = await createChatCompletionStreamResponse({
          providerId,
          model: modelId,
          messages,
          settings: effectiveSettings,
          signal: abortController.signal,
        });

        for await (const event of streamChatCompletionDeltas({ providerId, response: upstreamResponse })) {
          if (typeof event === "string") {
            const delta = event;
            if (!delta) continue;
            assistantContent += delta;
            writeSse(res, { type: "delta", delta });
            continue;
          }

          if (!event || typeof event !== "object") continue;

          if (event.type === "final") {
            if (typeof event.content === "string" && event.content.trim()) {
              finalAssistantContent = event.content;
            }
            continue;
          }

          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) continue;
          assistantContent += delta;
          writeSse(res, { type: "delta", delta });
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          const message = getAbortReasonMessage(abortController.signal);
          if (message && message !== "Client disconnected") {
            writeSse(res, { type: "error", error: message });
          }
          res.end();
          return;
        }
        throw streamError;
      } finally {
        clearTimeout(timeout);
      }

      const normalizedAssistantContent = (finalAssistantContent || assistantContent).trim();
      if (!normalizedAssistantContent) {
        writeSse(res, { type: "error", error: "Empty model response" });
        res.end();
        return;
      }

      const assistantMessage = await chatModel.createMessage(
        userId,
        sessionId,
        "assistant",
        normalizedAssistantContent
      );
      updatedSession = await chatModel.touchSession(userId, sessionId);
      errorSession = updatedSession;
      kickMemoryUpdate({ userId, presetId, needsMemory });
      kickRagTurnIndexing({
        userId,
        presetId,
        sessionId,
        userMessage,
        assistantMessage,
        userContent: userMessage?.content,
        assistantContent: normalizedAssistantContent,
      });
      requestAssistantGistGeneration({
        userId,
        presetId,
        messageId: assistantMessage?.id,
        userContent: userMessage?.content,
        content: normalizedAssistantContent,
      });

      writeSse(res, attachContextHealth({
        type: "done",
        session: updatedSession,
        user_message: userMessage,
        assistant_message: attachRagSources(assistantMessage, context),
      }, context, res));
      res.end();
    } catch (error) {
      const message = error?.message || "Internal Server Error";
      if (res.headersSent && res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
        try {
          writeSse(res, { type: "error", error: message });
          res.end();
        } catch {
          // ignore
        }
        return;
      }

      logger.error("chat_message_send_failed", withRequestContext(req, { error, sessionId: req.params.sessionId }));
      const payload = { error: message };
      if (errorSession) payload.session = errorSession;
      if (userMessage) payload.user_message = userMessage;
      res.status(500).json(payload);
    }
  },
};

module.exports = chatController;
