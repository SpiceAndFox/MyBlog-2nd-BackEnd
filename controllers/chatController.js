const chatModel = require("@models/chatModel");
const chatPresetModel = require("@models/chatPresetModel");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { chatConfig, llmConfig, chatRagConfig } = require("../config");
const { compileChatContextMessages } = require("../services/chat/contextCompiler");
const { markRecoveryNotificationsDelivered } = require("../modules/memory");
const memoryRuntime = require("../services/chat/memoryRuntime");
const { requestAssistantGistGeneration } = require("../services/chat/gistPipeline");
const {
  requestChatTurnIndexing,
  requestDeleteChunksFromMessageId,
} = require("../services/chat/rag/indexer");
const { logger, withRequestContext } = require("../logger");
const scopeCoordinator = require("../services/chat/scopeCoordinator");
const { deleteAvatarByUrl } = require("../services/chat/avatarStorage");

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

function readIdempotencyKey(req) {
  const value = req.get?.("Idempotency-Key") ?? req.body?.idempotencyKey;
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function privacyPayload(mutation) {
  return {
    operationId: mutation.operationId,
    status: mutation.status,
    rawMutationCommitted: Boolean(mutation.rawMutationCommitted),
    statusUrl: `/api/chat/privacy-operations/${mutation.operationId}`,
  };
}

function cancelScopeGeneration(userId, presetId, reason) {
  return scopeCoordinator.cancelByKey(
    scopeCoordinator.buildKey(userId, presetId),
    Object.assign(new Error(reason || "Chat source changed"), { code: "CHAT_SCOPE_MUTATED" }),
  );
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

function requestMemoryUpdate({ userId, presetId } = {}) {
  if (!memoryRuntime.enabled) return false;
  void memoryRuntime.processScope(userId, presetId);
  return true;
}

async function requestMemoryRebuild({ userId, presetId, reason } = {}) {
  if (!memoryRuntime.enabled) return null;
  return memoryRuntime.rebuildScope(userId, presetId, { reason });
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
  if (context?.rag?.stats?.degraded) {
    next.rag_health = {
      status: "degraded",
      reason: context.rag.stats.reason,
      failure: context.rag.stats.failure,
    };
  }
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
  if (memoryRuntime.enabled) return;
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
  if (memoryRuntime.enabled) return;
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
  async getPrivacyOperation(req, res) {
    try {
      const operation = await memoryRuntime.getPrivacyOperation(req.user?.id, req.params.operationId);
      if (!operation) return res.status(404).json({ error: "Privacy operation not found" });
      return res.status(200).json({
        privacy: {
          operationId: operation.operation_id ?? operation.operationId,
          presetId: operation.preset_id ?? operation.presetId,
          mode: operation.operation_mode ?? operation.operationMode,
          status: operation.status,
          rawMutationCommitted: true,
          lastErrorReason: operation.last_error_reason ?? operation.lastErrorReason ?? null,
          createdAt: operation.created_at ?? operation.createdAt,
          updatedAt: operation.updated_at ?? operation.updatedAt,
        },
      });
    } catch (error) {
      logger.error("chat_privacy_operation_get_failed", withRequestContext(req, { error }));
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },

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
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });

      const preset = await chatPresetModel.getPreset(userId, presetId);
      if (!preset) return res.status(404).json({ error: "Preset not found" });

      const rebuild = await requestMemoryRebuild({ userId, presetId: preset.id, reason: "manual_rebuild" });
      if (!rebuild) {
        return res.status(503).json({ error: "Memory Control v2 is disabled" });
      }

      res.status(202).json({
        presetId: preset.id,
        memory: { version: 2, ...rebuild },
      });
    } catch (error) {
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

      cancelScopeGeneration(userId, presetId, "Preset deleted");
      const result = await scopeCoordinator.enqueueByKey(
        scopeCoordinator.buildKey(userId, presetId),
        () => chatPresetModel.deletePreset(userId, presetId),
      );
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

      cancelScopeGeneration(userId, presetId, "Preset permanently deleted");
      const mutation = await memoryRuntime.privacyHardDelete(userId, presetId, {
        deleteScope: true,
        deleteRawSource: (client) => chatPresetModel.deletePresetPermanently(userId, presetId, { client }),
        operationPayload: (deletedPreset) => ({
          avatarUrls: deletedPreset.avatarUrl ? [deletedPreset.avatarUrl] : [],
        }),
      });
      const deleted = mutation.mutationResult;
      if (!deleted) return res.status(404).json({ error: "Preset not found" });
      return res.status(202).json({ presetId, privacy: privacyPayload(mutation) });
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
        preset = await scopeCoordinator.enqueueByKey(
          scopeCoordinator.buildKey(userId, presetId),
          async () => {
            const current = await chatPresetModel.getPreset(userId, presetId);
            if (!current || current.isBuiltin) return null;
            const previousAvatarUrl = current.avatarUrl || null;
            const updated = await chatPresetModel.updatePresetAvatar(userId, presetId, avatarUrl);
            if (updated && previousAvatarUrl && previousAvatarUrl !== avatarUrl) {
              try {
                await deleteAvatarByUrl(previousAvatarUrl);
              } catch (cleanupError) {
                try {
                  await chatPresetModel.updatePresetAvatar(userId, presetId, previousAvatarUrl);
                  await safeUnlink(processed.path);
                } catch (rollbackError) {
                  rollbackError.keepNewAvatar = true;
                  throw rollbackError;
                }
                throw cleanupError;
              }
            }
            return updated;
          },
        );
      } catch (updateError) {
        if (!updateError?.keepNewAvatar) await safeUnlink(processed.path);
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

      const existing = await chatModel.getSession(userId, sessionId);
      if (!existing) return res.status(404).json({ error: "Session not found" });
      const presetId = String(existing.preset_id || existing.presetId || "").trim();
      cancelScopeGeneration(userId, presetId, "Session trashed");
      const mutation = await memoryRuntime.mutateSourceAndRebuild(userId, presetId, {
        reason: "session_trashed",
        mutateSource: (client) => chatModel.trashSession(userId, sessionId, { client }),
      });
      const session = mutation.mutationResult;
      if (!session) return res.status(404).json({ error: "Session not found" });

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

      const existing = await chatModel.getTrashedSession(userId, sessionId);
      if (!existing) return res.status(404).json({ error: "Session not found" });
      const presetId = String(existing.preset_id || existing.presetId || "").trim();
      cancelScopeGeneration(userId, presetId, "Session restored");
      const mutation = await memoryRuntime.mutateSourceAndRebuild(userId, presetId, {
        reason: "session_restored",
        mutateSource: (client) => chatModel.restoreSession(userId, sessionId, { client }),
      });
      const session = mutation.mutationResult;
      if (!session) return res.status(404).json({ error: "Session not found" });

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

      const existing = await chatModel.getTrashedSession(userId, sessionId);
      if (!existing) return res.status(404).json({ error: "Session not found" });
      const presetId = String(existing.preset_id || existing.presetId || "").trim();
      cancelScopeGeneration(userId, presetId, "Session permanently deleted");
      const mutation = await memoryRuntime.privacyHardDelete(userId, presetId, {
        deleteRawSource: (client) => chatModel.deleteSessionPermanently(userId, sessionId, { client }),
      });
      const deletedSession = mutation.mutationResult;
      if (!deletedSession) return res.status(404).json({ error: "Session not found" });
      return res.status(202).json({ sessionId, privacy: privacyPayload(mutation) });
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

      const message = await chatModel.getMessage(userId, sessionId, messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      if (message.role !== "user") return res.status(400).json({ error: "Only user messages can be edited" });

      let updatedSession = session;

      const incomingSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      cancelScopeGeneration(userId, presetId, "Message edited");

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

      const nextTurnId = crypto.randomUUID();
      const regenerationKey = String(message.idempotency_key || "").trim() || `edit:${crypto.randomUUID()}`;
      let editedMessage = null;
      const mutation = await memoryRuntime.privacyHardDelete(userId, presetId, {
        deleteRawSource: async (client) => {
          if (truncate) await chatModel.deleteMessagesAfter(userId, sessionId, messageId, { client });
          const updated = await chatModel.updateMessageContent(userId, sessionId, messageId, content, {
            client,
            turnId: nextTurnId,
            idempotencyKey: regenerationKey,
          });
          if (!updated) throw new Error("Message disappeared during edit");
          editedMessage = updated;
          return updated;
        },
        afterGenerationInitialized: async (client, metadata) => {
          const updated = await chatModel.setMessageSourceGeneration(
            userId,
            sessionId,
            messageId,
            metadata.sourceGeneration,
            { client },
          );
          if (editedMessage && updated) Object.assign(editedMessage, updated);
        },
      });
      const updatedUserMessage = mutation.mutationResult;
      kickRagDeleteFromMessage({ userId, presetId, fromMessageId: messageId });

      updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings, presetId)) || updatedSession;

      if (mutation.status !== "completed") {
        return res.status(202).json({
          session: updatedSession,
          user_message: updatedUserMessage,
          privacy: privacyPayload(mutation),
          regeneration: regenerate
            ? {
              status: "blocked_until_privacy_completed",
              resumeAfterStatus: "completed",
              method: "POST",
              url: `/api/chat/sessions/${sessionId}/messages`,
              idempotencyKey: regenerationKey,
            }
            : undefined,
        });
      }

      if (!regenerate) {
        updatedSession = (await chatModel.touchSession(userId, sessionId)) || updatedSession;
        return res.status(200).json({ session: updatedSession, user_message: updatedUserMessage });
      }
      return res.status(409).json({
        error: "Regeneration must resume through the send endpoint after the privacy operation completes",
        regeneration: {
          method: "POST",
          url: `/api/chat/sessions/${sessionId}/messages`,
          idempotencyKey: regenerationKey,
        },
      });
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

  async _sendMessageInScope(_req, res, scopeSignal) {
    const req = _req;
    let errorSession = null;
    let userMessage = null;

    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Content cannot be empty" });
      const idempotencyKey = readIdempotencyKey(req);
      if (!idempotencyKey) return res.status(400).json({ error: "Idempotency-Key header is required" });

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

      const userInsert = await chatModel.createUserMessage(userId, sessionId, content, {
        turnId: crypto.randomUUID(),
        idempotencyKey,
      });
      userMessage = userInsert.message;
      if (!userMessage) {
        if (userInsert.blocked) return res.status(409).json({ error: "Privacy operation is still in progress" });
        return res.status(404).json({ error: "Session not found" });
      }
      if (!userInsert.created) {
        const existingAssistant = await chatModel.getAssistantForUserMessage(userId, userMessage.id);
        if (existingAssistant) {
          return res.status(200).json({
            session: updatedSession,
            user_message: userMessage,
            assistant_message: existingAssistant,
            idempotent_replay: true,
          });
        }
      }

      const context = await compileChatContextMessages({
        userId,
        presetId,
        systemPrompt: effectiveSettings.systemPrompt,
        upToMessageId: userMessage.id,
        signal: scopeSignal,
      });
      const messages = context.messages;

      logger.debug(
        "chat_context_compiled",
        withRequestContext(req, {
          sessionId,
          presetId,
          segments: context.segments,
          memory: context.memory,
        })
      );
      if (!shouldStream) {
        const { content: assistantContent } = await createChatCompletion({
          providerId,
          model: modelId,
          messages,
          settings: effectiveSettings,
          signal: scopeSignal,
        });

        const { message: assistantMessage } = await chatModel.createAssistantMessageForTurn(
          userId,
          sessionId,
          userMessage.id,
          userMessage.turn_id,
          assistantContent,
        );
        updatedSession = await chatModel.touchSession(userId, sessionId);
        errorSession = updatedSession;
        requestMemoryUpdate({ userId, presetId });
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
      const abortFromScope = () => abortController.abort(scopeSignal?.reason || new Error("Request cancelled"));
      if (scopeSignal?.aborted) abortFromScope();
      else scopeSignal?.addEventListener("abort", abortFromScope, { once: true });
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
        scopeSignal?.removeEventListener("abort", abortFromScope);
      }

      const normalizedAssistantContent = (finalAssistantContent || assistantContent).trim();
      if (!normalizedAssistantContent) {
        writeSse(res, { type: "error", error: "Empty model response" });
        res.end();
        return;
      }

      const { message: assistantMessage } = await chatModel.createAssistantMessageForTurn(
        userId,
        sessionId,
        userMessage.id,
        userMessage.turn_id,
        normalizedAssistantContent
      );
      updatedSession = await chatModel.touchSession(userId, sessionId);
      errorSession = updatedSession;
      requestMemoryUpdate({ userId, presetId });
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
      const status = ["CHAT_IDEMPOTENCY_CONFLICT", "CHAT_TURN_STALE", "CHAT_SCOPE_MUTATED"].includes(error?.code)
        ? 409
        : 500;
      res.status(status).json(payload);
    }
  },

  async sendMessage(req, res) {
    const userId = req.user?.id;
    const sessionId = parseSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });
    if (!readIdempotencyKey(req)) {
      return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    try {
      const session = await chatModel.getSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      const presetId = getSessionPresetId(session);
      if (!presetId) return res.status(409).json({ error: "Session has no valid preset" });

      const clientAbort = new AbortController();
      const onResponseClose = () => {
        if (!res.writableEnded) clientAbort.abort(new Error("Client disconnected"));
      };
      res.once("close", onResponseClose);
      try {
        return await scopeCoordinator.enqueueByKey(
          scopeCoordinator.buildKey(userId, presetId),
          ({ signal }) => chatController._sendMessageInScope(req, res, signal),
          { cancellable: true, signal: clientAbort.signal },
        );
      } finally {
        res.removeListener("close", onResponseClose);
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error?.code === "CHAT_SCOPE_MUTATED" ? 409 : 500;
      if (!res.headersSent) return res.status(status).json({ error: error?.message || "Internal Server Error" });
      try { res.end(); } catch { /* ignore */ }
    }
  },
};

module.exports = chatController;
