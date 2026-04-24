const { readBoolEnv, readFloatEnv, readIntEnv, readStringEnv } = require("./readEnv");
const { getGlobalNumericRange, getProviderNumericRange, clampNumberWithRange } = require("../services/llm/settingsSchema");
const { getProviderDefinition } = require("../services/llm/providers");

function normalizeKey(value) {
  return String(value || "").trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalStringEnv(name) {
  return readStringEnv(name, undefined);
}

function readRequiredJsonEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`Missing required env: ${name}`);

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Env ${name} is not valid JSON`);
  }
}

function readRequiredJsonObjectEnv(name) {
  const value = readRequiredJsonEnv(name);
  if (!isPlainObject(value)) throw new Error(`Env ${name} must be a JSON object`);
  return value;
}

function ensureValidTimeZone(timeZone, { name } = {}) {
  const normalized = normalizeKey(timeZone);
  if (!normalized) throw new Error(`Env ${name || "unknown"} cannot be empty`);

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    throw new Error(`Env ${name || "unknown"} has invalid IANA time zone: ${normalized}`);
  }

  return normalized;
}

function readRequiredStringEnv(name) {
  const value = readOptionalStringEnv(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const chatDayTimeZone = ensureValidTimeZone(readRequiredStringEnv("CHAT_DAY_TIME_ZONE"), { name: "CHAT_DAY_TIME_ZONE" });

function readOptionalBoolEnv(name) {
  return readBoolEnv(name, undefined);
}

function readRequiredBoolEnv(name) {
  const value = readOptionalBoolEnv(name);
  if (typeof value !== "boolean") throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function readRequiredIntEnv(name) {
  const value = readIntEnv(name);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function readOptionalFloatEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = readFloatEnv(name);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readOptionalIntEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = readIntEnv(name);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readOptionalBoolEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  if (!raw.trim()) return undefined;

  const parsed = readBoolEnv(name, undefined);
  if (typeof parsed !== "boolean") throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readRequiredFloatEnv(name) {
  const value = readFloatEnv(name);
  if (!Number.isFinite(value)) throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function ensureNumberInRange(value, range, { name } = {}) {
  if (!Number.isFinite(value)) throw new Error(`Invalid env: ${name || "unknown"}`);
  if (!range) return value;
  if (Number.isFinite(range.min) && value < range.min)
    throw new Error(`Env ${name} out of range (min ${range.min}). Got: ${value}`);
  if (Number.isFinite(range.max) && value > range.max)
    throw new Error(`Env ${name} out of range (max ${range.max}). Got: ${value}`);
  return value;
}

function readRequiredSettingNumber(name, { key, providerId, integer } = {}) {
  const resolvedKey = normalizeKey(key);
  const resolvedProviderId = normalizeKey(providerId);
  const range =
    resolvedProviderId && resolvedKey
      ? getProviderNumericRange(resolvedProviderId, resolvedKey) || getGlobalNumericRange(resolvedKey)
      : resolvedKey
      ? getGlobalNumericRange(resolvedKey)
      : null;

  const value = integer ? readRequiredIntEnv(name) : readRequiredFloatEnv(name);
  return ensureNumberInRange(value, range, { name });
}

function ensurePositiveInt(value, { name } = {}) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Env ${name} must be a positive integer. Got: ${String(value)}`);
  }
  return value;
}

function ensureNonNegativeInt(value, { name } = {}) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Env ${name} must be a non-negative integer. Got: ${String(value)}`);
  }
  return value;
}

function ensureSupportedProvider(providerId, { name } = {}) {
  const normalizedProviderId = normalizeKey(providerId);
  if (!normalizedProviderId) throw new Error(`Env ${name} cannot be empty`);
  const definition = getProviderDefinition(normalizedProviderId);
  if (!definition) throw new Error(`Env ${name} has unsupported provider: ${normalizedProviderId}`);
  return normalizedProviderId;
}

function ensureSupportedModel(providerId, modelId, { name } = {}) {
  const normalizedProviderId = normalizeKey(providerId);
  const normalizedModelId = normalizeKey(modelId);
  if (!normalizedModelId) throw new Error(`Env ${name} cannot be empty`);

  const definition = getProviderDefinition(normalizedProviderId);
  const models = Array.isArray(definition?.models) ? definition.models : [];
  const supported = models.some((model) => normalizeKey(model?.id) === normalizedModelId);
  if (!supported) {
    throw new Error(`Env ${name} has unsupported model for provider ${normalizedProviderId}: ${normalizedModelId}`);
  }

  return normalizedModelId;
}

function readProviderDefaultSettings({ providerId, envPrefix, baseDefaults } = {}) {
  const base = baseDefaults && typeof baseDefaults === "object" && !Array.isArray(baseDefaults) ? baseDefaults : {};
  const normalizedProviderId = ensureSupportedProvider(providerId, { name: "providerId" });
  const normalizedPrefix = String(envPrefix || "")
    .trim()
    .toUpperCase();
  if (!normalizedPrefix) return { ...base };

  const definition = getProviderDefinition(normalizedProviderId);
  const capabilities = definition?.capabilities || {};
  const supportsStream = capabilities.stream !== false;
  const supportsWebSearch = capabilities.webSearch !== false;

  const next = { ...base };

  function clampProviderFloatSetting(key, envSuffix) {
    const envKey = `${normalizedPrefix}_${envSuffix}`;
    const range = getProviderNumericRange(normalizedProviderId, key);

    if (!range) {
      if (readOptionalFloatEnvStrict(envKey) !== undefined) {
        throw new Error(`Env ${envKey} is not supported by provider: ${normalizedProviderId}`);
      }
      delete next[key];
      return;
    }

    const override = readOptionalFloatEnvStrict(envKey);
    const value = override === undefined ? base[key] : override;
    next[key] = ensureNumberInRange(value, range, { name: envKey });
  }

  function clampProviderIntSetting(key, envSuffix) {
    const envKey = `${normalizedPrefix}_${envSuffix}`;
    const range = getProviderNumericRange(normalizedProviderId, key);

    if (!range) {
      if (readOptionalIntEnvStrict(envKey) !== undefined) {
        throw new Error(`Env ${envKey} is not supported by provider: ${normalizedProviderId}`);
      }
      delete next[key];
      return;
    }

    const override = readOptionalIntEnvStrict(envKey);
    const value = override === undefined ? base[key] : override;
    next[key] = ensureNumberInRange(value, range, { name: envKey });
  }

  clampProviderFloatSetting("temperature", "DEFAULT_TEMPERATURE");
  clampProviderFloatSetting("topP", "DEFAULT_TOP_P");
  clampProviderIntSetting("maxOutputTokens", "DEFAULT_MAX_OUTPUT_TOKENS");
  clampProviderFloatSetting("presencePenalty", "DEFAULT_PRESENCE_PENALTY");
  clampProviderFloatSetting("frequencyPenalty", "DEFAULT_FREQUENCY_PENALTY");

  const streamOverride = readOptionalBoolEnvStrict(`${normalizedPrefix}_DEFAULT_STREAM`);
  if (!supportsStream) {
    if (streamOverride === true) {
      throw new Error(`Env ${normalizedPrefix}_DEFAULT_STREAM is not supported by provider: ${normalizedProviderId}`);
    }
    next.stream = false;
  } else {
    next.stream = streamOverride === undefined ? base.stream : streamOverride;
  }

  const webSearchOverride = readOptionalBoolEnvStrict(`${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH`);
  if (!supportsWebSearch) {
    if (webSearchOverride === true) {
      throw new Error(
        `Env ${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH is not supported by provider: ${normalizedProviderId}`
      );
    }
    next.enableWebSearch = false;
  } else {
    next.enableWebSearch = webSearchOverride === undefined ? base.enableWebSearch : webSearchOverride;
  }
  if (!supportsWebSearch) next.enableWebSearch = false;

  return next;
}

const baseChatDefaultSettings = {
  temperature: readRequiredSettingNumber("CHAT_DEFAULT_TEMPERATURE", { key: "temperature" }),
  topP: readRequiredSettingNumber("CHAT_DEFAULT_TOP_P", { key: "topP" }),
  maxOutputTokens: readRequiredSettingNumber("CHAT_DEFAULT_MAX_OUTPUT_TOKENS", {
    key: "maxOutputTokens",
    integer: true,
  }),
  presencePenalty: readRequiredSettingNumber("CHAT_DEFAULT_PRESENCE_PENALTY", { key: "presencePenalty" }),
  frequencyPenalty: readRequiredSettingNumber("CHAT_DEFAULT_FREQUENCY_PENALTY", { key: "frequencyPenalty" }),
  stream: readRequiredBoolEnv("CHAT_DEFAULT_STREAM"),
  enableWebSearch: readRequiredBoolEnv("CHAT_DEFAULT_ENABLE_WEB_SEARCH"),
  systemPromptPresetId: readRequiredStringEnv("CHAT_DEFAULT_SYSTEM_PROMPT_PRESET_ID"),
};

const chatConfig = {
  dayTimeZone: chatDayTimeZone,
  recentWindowMaxMessages: ensurePositiveInt(readRequiredIntEnv("CHAT_RECENT_WINDOW_MAX_MESSAGES"), {
    name: "CHAT_RECENT_WINDOW_MAX_MESSAGES",
  }),
  recentWindowMaxChars: ensurePositiveInt(readRequiredIntEnv("CHAT_RECENT_WINDOW_MAX_CHARS"), {
    name: "CHAT_RECENT_WINDOW_MAX_CHARS",
  }),
  trashRetentionDays: ensureNonNegativeInt(readRequiredIntEnv("CHAT_TRASH_RETENTION_DAYS"), {
    name: "CHAT_TRASH_RETENTION_DAYS",
  }),
  trashCleanupIntervalMs: ensurePositiveInt(readRequiredIntEnv("CHAT_TRASH_CLEAN_INTERVAL_MS"), {
    name: "CHAT_TRASH_CLEAN_INTERVAL_MS",
  }),
  trashPurgeBatchSize: ensurePositiveInt(readRequiredIntEnv("CHAT_TRASH_PURGE_BATCH_SIZE"), {
    name: "CHAT_TRASH_PURGE_BATCH_SIZE",
  }),
  defaultProviderId: ensureSupportedProvider(readRequiredStringEnv("CHAT_DEFAULT_PROVIDER"), {
    name: "CHAT_DEFAULT_PROVIDER",
  }),
  defaultModelByProvider: {
    grok: ensureSupportedModel("grok", readRequiredStringEnv("GROK_DEFAULT_MODEL"), { name: "GROK_DEFAULT_MODEL" }),
    deepseek: ensureSupportedModel("deepseek", readRequiredStringEnv("DEEPSEEK_DEFAULT_MODEL"), {
      name: "DEEPSEEK_DEFAULT_MODEL",
    }),
    gemini: ensureSupportedModel("gemini", readRequiredStringEnv("GEMINI_DEFAULT_MODEL"), {
      name: "GEMINI_DEFAULT_MODEL",
    }),
    openrouter: ensureSupportedModel("openrouter", readRequiredStringEnv("OPENROUTER_DEFAULT_MODEL"), {
      name: "OPENROUTER_DEFAULT_MODEL",
    }),
  },
  defaultSettings: baseChatDefaultSettings,
  defaultSettingsByProvider: {
    grok: readProviderDefaultSettings({ providerId: "grok", envPrefix: "GROK", baseDefaults: baseChatDefaultSettings }),
    deepseek: readProviderDefaultSettings({
      providerId: "deepseek",
      envPrefix: "DEEPSEEK",
      baseDefaults: baseChatDefaultSettings,
    }),
    gemini: readProviderDefaultSettings({
      providerId: "gemini",
      envPrefix: "GEMINI",
      baseDefaults: baseChatDefaultSettings,
    }),
    openrouter: readProviderDefaultSettings({
      providerId: "openrouter",
      envPrefix: "OPENROUTER",
      baseDefaults: baseChatDefaultSettings,
    }),
  },
};

const chatTimeContextConfig = (() => {
  const enabled = readRequiredBoolEnv("CHAT_TIME_CONTEXT_ENABLED");
  const timeZone = ensureValidTimeZone(readRequiredStringEnv("CHAT_TIME_CONTEXT_TIME_ZONE"), {
    name: "CHAT_TIME_CONTEXT_TIME_ZONE",
  });
  const template = readRequiredStringEnv("CHAT_TIME_CONTEXT_TEMPLATE");
  const userTemplate = readRequiredStringEnv("CHAT_TIME_CONTEXT_USER_TEMPLATE");

  return {
    enabled,
    timeZone,
    template,
    userTemplate,
  };
})();

const chatMemoryConfig = (() => {
  const rollingSummaryMaxChars = ensurePositiveInt(readRequiredIntEnv("CHAT_ROLLING_SUMMARY_MAX_CHARS"), {
    name: "CHAT_ROLLING_SUMMARY_MAX_CHARS",
  });

  const rollingSummaryUpdateEveryNTurns = ensurePositiveInt(
    readRequiredIntEnv("CHAT_MEMORY_ROLLING_SUMMARY_UPDATE_EVERY_N_TURNS"),
    { name: "CHAT_MEMORY_ROLLING_SUMMARY_UPDATE_EVERY_N_TURNS" }
  );

  const coreMemoryEnabled = readRequiredBoolEnv("CHAT_MEMORY_CORE_ENABLED");

  const coreMemoryStrictSyncWithRsCheckpointEnabled = readRequiredBoolEnv(
    "CHAT_MEMORY_CORE_STRICT_SYNC_WITH_RS_CHECKPOINT_ENABLED"
  );

  const coreMemoryMaxChars = ensurePositiveInt(readRequiredIntEnv("CHAT_MEMORY_CORE_MAX_CHARS"), {
    name: "CHAT_MEMORY_CORE_MAX_CHARS",
  });

  const coreMemoryUpdateEveryNTurns = ensurePositiveInt(
    readRequiredIntEnv("CHAT_MEMORY_CORE_UPDATE_EVERY_N_TURNS"),
    { name: "CHAT_MEMORY_CORE_UPDATE_EVERY_N_TURNS" }
  );

  const coreMemoryDeltaBatchMessages = ensurePositiveInt(readRequiredIntEnv("CHAT_MEMORY_CORE_DELTA_BATCH_MESSAGES"), {
    name: "CHAT_MEMORY_CORE_DELTA_BATCH_MESSAGES",
  });

  const gapBridgeMaxMessages = ensurePositiveInt(readRequiredIntEnv("CHAT_MEMORY_GAP_BRIDGE_MAX_MESSAGES"), {
    name: "CHAT_MEMORY_GAP_BRIDGE_MAX_MESSAGES",
  });

  const gapBridgeMaxChars = ensurePositiveInt(readRequiredIntEnv("CHAT_MEMORY_GAP_BRIDGE_MAX_CHARS"), {
    name: "CHAT_MEMORY_GAP_BRIDGE_MAX_CHARS",
  });

  const recentWindowAssistantGistEnabled = readRequiredBoolEnv("CHAT_RECENT_WINDOW_ASSISTANT_GIST_ENABLED");

  const recentWindowAssistantRawLastN = ensureNonNegativeInt(readRequiredIntEnv("CHAT_RECENT_WINDOW_ASSISTANT_RAW_LAST_N"), {
    name: "CHAT_RECENT_WINDOW_ASSISTANT_RAW_LAST_N",
  });

  const recentWindowAssistantGistPrefix = readRequiredStringEnv("CHAT_RECENT_WINDOW_ASSISTANT_GIST_PREFIX");

  const workerProviderId = ensureSupportedProvider(readRequiredStringEnv("CHAT_MEMORY_WORKER_PROVIDER"), {
    name: "CHAT_MEMORY_WORKER_PROVIDER",
  });

  const workerModelId = ensureSupportedModel(workerProviderId, readRequiredStringEnv("CHAT_MEMORY_WORKER_MODEL"), {
    name: "CHAT_MEMORY_WORKER_MODEL",
  });

  const workerConcurrency = ensurePositiveInt(readRequiredIntEnv("CHAT_MEMORY_WORKER_CONCURRENCY"), {
    name: "CHAT_MEMORY_WORKER_CONCURRENCY",
  });

  const backfillBatchMessages = ensurePositiveInt(
    readRequiredIntEnv("CHAT_MEMORY_BACKFILL_BATCH_MESSAGES"),
    { name: "CHAT_MEMORY_BACKFILL_BATCH_MESSAGES" }
  );

  const backfillCooldownMs = ensureNonNegativeInt(
    readRequiredIntEnv("CHAT_MEMORY_BACKFILL_COOLDOWN_MS"),
    { name: "CHAT_MEMORY_BACKFILL_COOLDOWN_MS" }
  );

  const checkpointEveryNMessages = ensureNonNegativeInt(readRequiredIntEnv("CHAT_MEMORY_CHECKPOINT_EVERY_N_MESSAGES"), {
    name: "CHAT_MEMORY_CHECKPOINT_EVERY_N_MESSAGES",
  });

  const checkpointKeepLastN = ensureNonNegativeInt(readRequiredIntEnv("CHAT_MEMORY_CHECKPOINT_KEEP_LAST_N"), {
    name: "CHAT_MEMORY_CHECKPOINT_KEEP_LAST_N",
  });

  if (coreMemoryStrictSyncWithRsCheckpointEnabled && (checkpointEveryNMessages <= 0 || checkpointKeepLastN <= 0)) {
    throw new Error(
      "CHAT_MEMORY_CORE_STRICT_SYNC_WITH_RS_CHECKPOINT_ENABLED requires checkpoint feature enabled: " +
        "set CHAT_MEMORY_CHECKPOINT_EVERY_N_MESSAGES > 0 and CHAT_MEMORY_CHECKPOINT_KEEP_LAST_N > 0"
    );
  }

  const writeRetryMax = ensureNonNegativeInt(readRequiredIntEnv("CHAT_MEMORY_WRITE_RETRY_MAX"), {
    name: "CHAT_MEMORY_WRITE_RETRY_MAX",
  });

  const syncRebuildTimeoutMs = ensurePositiveInt(
    readRequiredIntEnv("CHAT_MEMORY_SYNC_REBUILD_TIMEOUT_MS"),
    { name: "CHAT_MEMORY_SYNC_REBUILD_TIMEOUT_MS" }
  );

  const syncRebuildTotalTimeoutMs = ensureNonNegativeInt(
    readRequiredIntEnv("CHAT_MEMORY_SYNC_REBUILD_TOTAL_TIMEOUT_MS"),
    { name: "CHAT_MEMORY_SYNC_REBUILD_TOTAL_TIMEOUT_MS" }
  );

  function sanitizeWorkerSettings(rawSettings) {
    if (!isPlainObject(rawSettings)) return {};

    const sanitized = {};

    const keys = [
      "temperature",
      "topP",
      "maxOutputTokens",
      "presencePenalty",
      "frequencyPenalty",
      "thinkingBudget",
      "stream",
      "enableWebSearch",
    ];

    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(rawSettings, key)) continue;
      if (key === "stream" || key === "enableWebSearch") {
        if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
        continue;
      }

      const number = Number(rawSettings[key]);
      if (Number.isFinite(number)) sanitized[key] = number;
    }

    const definition = getProviderDefinition(workerProviderId);
    const schema = Array.isArray(definition?.settingsSchema) ? definition.settingsSchema : [];
    const modelId = workerModelId;

    for (const control of schema) {
      const key = normalizeKey(control?.key);
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(sanitized, key)) continue;

      const blocklist = Array.isArray(control?.modelBlocklist) ? control.modelBlocklist : [];
      if (modelId && blocklist.includes(modelId)) continue;

      const type = normalizeKey(control?.type);

      if (type === "toggle") {
        if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
        continue;
      }

      if (type === "select") {
        if (typeof rawSettings[key] !== "string") continue;
        const value = rawSettings[key].trim();
        if (!value) continue;

        const options = Array.isArray(control.options) ? control.options : [];
        const allowed = new Set(options.map((option) => normalizeKey(option?.value)).filter(Boolean));
        if (!allowed.has(value)) continue;

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

  function normalizeWorkerSettings(settings) {
    if (!isPlainObject(settings)) return {};

    const normalized = { ...settings };
    const keys = ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty", "thinkingBudget"];

    for (const key of keys) {
      if (normalized[key] === undefined) continue;

      const range = getProviderNumericRange(workerProviderId, key);
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

    return normalized;
  }

  function buildWorkerSettingsForMemory(maxOutputTokensEnvName) {
    const rawWorkerSettings = {
      temperature: readRequiredSettingNumber("CHAT_MEMORY_WORKER_TEMPERATURE", {
        key: "temperature",
        providerId: workerProviderId,
      }),
      topP: readRequiredSettingNumber("CHAT_MEMORY_WORKER_TOP_P", { key: "topP", providerId: workerProviderId }),
      maxOutputTokens: readRequiredSettingNumber(maxOutputTokensEnvName, {
        key: "maxOutputTokens",
        providerId: workerProviderId,
        integer: true,
      }),
      stream: readRequiredBoolEnv("CHAT_MEMORY_WORKER_STREAM"),
      enableWebSearch: readRequiredBoolEnv("CHAT_MEMORY_WORKER_ENABLE_WEB_SEARCH"),
      thinkingMode:
        readOptionalStringEnv("CHAT_MEMORY_WORKER_DEEPSEEK_THINKING_MODE") ||
        readOptionalStringEnv("CHAT_MEMORY_WORKER_THINKING_MODE"),
      reasoningEffort:
        readOptionalStringEnv("CHAT_MEMORY_WORKER_DEEPSEEK_REASONING_EFFORT") ||
        readOptionalStringEnv("CHAT_MEMORY_WORKER_REASONING_EFFORT"),
      thinkingLevel:
        readOptionalStringEnv("CHAT_MEMORY_WORKER_GEMINI_THINKING_LEVEL") ||
        readOptionalStringEnv("CHAT_MEMORY_WORKER_THINKING_LEVEL"),
      thinkingBudget:
        readOptionalIntEnvStrict("CHAT_MEMORY_WORKER_GEMINI_THINKING_BUDGET") ??
        readOptionalIntEnvStrict("CHAT_MEMORY_WORKER_THINKING_BUDGET"),
      safetyHarassment: readOptionalStringEnv("CHAT_MEMORY_WORKER_SAFETY_HARASSMENT"),
      safetyHateSpeech: readOptionalStringEnv("CHAT_MEMORY_WORKER_SAFETY_HATE_SPEECH"),
      safetySexuallyExplicit: readOptionalStringEnv("CHAT_MEMORY_WORKER_SAFETY_SEXUALLY_EXPLICIT"),
      safetyDangerousContent: readOptionalStringEnv("CHAT_MEMORY_WORKER_SAFETY_DANGEROUS_CONTENT"),
    };

    return normalizeWorkerSettings(sanitizeWorkerSettings(rawWorkerSettings));
  }

  const rollingSummaryWorkerSettings = buildWorkerSettingsForMemory("CHAT_MEMORY_ROLLING_SUMMARY_WORKER_MAX_OUTPUT_TOKENS");
  const coreMemoryWorkerSettings = buildWorkerSettingsForMemory("CHAT_MEMORY_CORE_WORKER_MAX_OUTPUT_TOKENS");

  const openaiCompatibleBody = readRequiredJsonObjectEnv("CHAT_MEMORY_WORKER_OPENAI_COMPATIBLE_BODY_JSON");
  const googleGenAiConfig = readRequiredJsonObjectEnv("CHAT_MEMORY_WORKER_GOOGLE_GENAI_CONFIG_JSON");

  return {
    rollingSummaryMaxChars,
    rollingSummaryUpdateEveryNTurns,
    coreMemoryEnabled,
    coreMemoryStrictSyncWithRsCheckpointEnabled,
    coreMemoryMaxChars,
    coreMemoryUpdateEveryNTurns,
    coreMemoryDeltaBatchMessages,
    gapBridgeMaxMessages,
    gapBridgeMaxChars,
    recentWindowAssistantGistEnabled,
    recentWindowAssistantRawLastN,
    recentWindowAssistantGistPrefix,
    workerProviderId,
    workerModelId,
    workerConcurrency,
    backfillBatchMessages,
    backfillCooldownMs,
    checkpointEveryNMessages,
    checkpointKeepLastN,
    writeRetryMax,
    syncRebuildTimeoutMs,
    syncRebuildTotalTimeoutMs,
    rollingSummaryWorkerSettings,
    coreMemoryWorkerSettings,
    workerRaw: {
      openaiCompatibleBody,
      googleGenAiConfig,
    },
  };
})();

const chatGistConfig = (() => {
  const enabled = readRequiredBoolEnv("CHAT_GIST_ENABLED");
  const maxChars = ensurePositiveInt(readRequiredIntEnv("CHAT_GIST_MAX_CHARS"), { name: "CHAT_GIST_MAX_CHARS" });

  const workerProviderId = ensureSupportedProvider(readRequiredStringEnv("CHAT_GIST_WORKER_PROVIDER"), {
    name: "CHAT_GIST_WORKER_PROVIDER",
  });

  const workerModelId = ensureSupportedModel(workerProviderId, readRequiredStringEnv("CHAT_GIST_WORKER_MODEL"), {
    name: "CHAT_GIST_WORKER_MODEL",
  });

  const workerConcurrency = ensurePositiveInt(readRequiredIntEnv("CHAT_GIST_WORKER_CONCURRENCY"), {
    name: "CHAT_GIST_WORKER_CONCURRENCY",
  });

  const workerTimeoutMs = ensurePositiveInt(readRequiredIntEnv("CHAT_GIST_WORKER_TIMEOUT_MS"), {
    name: "CHAT_GIST_WORKER_TIMEOUT_MS",
  });

  function sanitizeWorkerSettings(rawSettings) {
    if (!isPlainObject(rawSettings)) return {};

    const sanitized = {};

    const keys = [
      "temperature",
      "topP",
      "maxOutputTokens",
      "presencePenalty",
      "frequencyPenalty",
      "thinkingBudget",
      "stream",
      "enableWebSearch",
    ];

    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(rawSettings, key)) continue;
      if (key === "stream" || key === "enableWebSearch") {
        if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
        continue;
      }

      const number = Number(rawSettings[key]);
      if (Number.isFinite(number)) sanitized[key] = number;
    }

    const definition = getProviderDefinition(workerProviderId);
    const schema = Array.isArray(definition?.settingsSchema) ? definition.settingsSchema : [];
    const modelId = workerModelId;

    for (const control of schema) {
      const key = normalizeKey(control?.key);
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(sanitized, key)) continue;

      const blocklist = Array.isArray(control?.modelBlocklist) ? control.modelBlocklist : [];
      if (modelId && blocklist.includes(modelId)) continue;

      const type = normalizeKey(control?.type);

      if (type === "toggle") {
        if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
        continue;
      }

      if (type === "select") {
        if (typeof rawSettings[key] !== "string") continue;
        const value = rawSettings[key].trim();
        if (!value) continue;

        const options = Array.isArray(control.options) ? control.options : [];
        const allowed = new Set(options.map((option) => normalizeKey(option?.value)).filter(Boolean));
        if (!allowed.has(value)) continue;

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

  function normalizeWorkerSettings(settings) {
    if (!isPlainObject(settings)) return {};

    const normalized = { ...settings };
    const keys = ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty", "thinkingBudget"];

    for (const key of keys) {
      if (normalized[key] === undefined) continue;

      const range = getProviderNumericRange(workerProviderId, key);
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

    return normalized;
  }

  const rawWorkerSettings = {
    temperature: readRequiredSettingNumber("CHAT_GIST_WORKER_TEMPERATURE", {
      key: "temperature",
      providerId: workerProviderId,
    }),
    topP: readRequiredSettingNumber("CHAT_GIST_WORKER_TOP_P", { key: "topP", providerId: workerProviderId }),
    maxOutputTokens: readRequiredSettingNumber("CHAT_GIST_WORKER_MAX_OUTPUT_TOKENS", {
      key: "maxOutputTokens",
      providerId: workerProviderId,
      integer: true,
    }),
    stream: readRequiredBoolEnv("CHAT_GIST_WORKER_STREAM"),
    enableWebSearch: readRequiredBoolEnv("CHAT_GIST_WORKER_ENABLE_WEB_SEARCH"),
    thinkingMode:
      readOptionalStringEnv("CHAT_GIST_WORKER_DEEPSEEK_THINKING_MODE") ||
      readOptionalStringEnv("CHAT_GIST_WORKER_THINKING_MODE"),
    reasoningEffort:
      readOptionalStringEnv("CHAT_GIST_WORKER_DEEPSEEK_REASONING_EFFORT") ||
      readOptionalStringEnv("CHAT_GIST_WORKER_REASONING_EFFORT"),
    thinkingLevel:
      readOptionalStringEnv("CHAT_GIST_WORKER_GEMINI_THINKING_LEVEL") ||
      readOptionalStringEnv("CHAT_GIST_WORKER_THINKING_LEVEL"),
    thinkingBudget:
      readOptionalIntEnvStrict("CHAT_GIST_WORKER_GEMINI_THINKING_BUDGET") ??
      readOptionalIntEnvStrict("CHAT_GIST_WORKER_THINKING_BUDGET"),
    safetyHarassment: readOptionalStringEnv("CHAT_GIST_WORKER_SAFETY_HARASSMENT"),
    safetyHateSpeech: readOptionalStringEnv("CHAT_GIST_WORKER_SAFETY_HATE_SPEECH"),
    safetySexuallyExplicit: readOptionalStringEnv("CHAT_GIST_WORKER_SAFETY_SEXUALLY_EXPLICIT"),
    safetyDangerousContent: readOptionalStringEnv("CHAT_GIST_WORKER_SAFETY_DANGEROUS_CONTENT"),
  };

  const workerSettings = normalizeWorkerSettings(sanitizeWorkerSettings(rawWorkerSettings));

  const openaiCompatibleBody = readRequiredJsonObjectEnv("CHAT_GIST_WORKER_OPENAI_COMPATIBLE_BODY_JSON");
  const googleGenAiConfig = readRequiredJsonObjectEnv("CHAT_GIST_WORKER_GOOGLE_GENAI_CONFIG_JSON");

  return {
    enabled,
    maxChars,
    workerProviderId,
    workerModelId,
    workerConcurrency,
    workerTimeoutMs,
    workerSettings,
    workerRaw: {
      openaiCompatibleBody,
      googleGenAiConfig,
    },
  };
})();

const llmConfig = {
  timeoutMs: ensurePositiveInt(readRequiredIntEnv("LLM_TIMEOUT_MS"), { name: "LLM_TIMEOUT_MS" }),
};

const logConfig = {
  level: readStringEnv("LOG_LEVEL", "info"),
  toConsole: readBoolEnv("LOG_TO_CONSOLE", true),
  toFile: readBoolEnv("LOG_TO_FILE", true),
  dir: readStringEnv("LOG_DIR", "logs"),
  errorFile: readStringEnv("LOG_ERROR_FILE", "error.log"),
  warnFile: readStringEnv("LOG_WARN_FILE", "warn.log"),
  infoFile: readStringEnv("LOG_INFO_FILE", "info.log"),
  debugFile: readStringEnv("LOG_DEBUG_FILE", "debug.log"),
  chatFile: readStringEnv("LOG_CHAT_FILE", ""),
  debugFullFile: readStringEnv("LOG_DEBUG_FULL_FILE", "debug-full.log"),
  debugRollingFile: readStringEnv("LOG_DEBUG_ROLLING_FILE", "debug-rolling.log"),
  debugGistFile: readStringEnv("LOG_DEBUG_GIST_FILE", "debug-gist.log"),
  debugCoreFile: readStringEnv("LOG_DEBUG_CORE_FILE", "debug-core.log"),
  debugFullEnabled: readBoolEnv("LOG_DEBUG_FULL_ENABLED", true),
  debugRollingEnabled: readBoolEnv("LOG_DEBUG_ROLLING_ENABLED", true),
  debugGistEnabled: readBoolEnv("LOG_DEBUG_GIST_ENABLED", true),
  debugCoreEnabled: readBoolEnv("LOG_DEBUG_CORE_ENABLED", true),
};

const articleConfig = {
  tempImageTtlMs: ensurePositiveInt(readRequiredIntEnv("ARTICLE_TEMP_IMAGE_TTL_MS"), {
    name: "ARTICLE_TEMP_IMAGE_TTL_MS",
  }),
  cleanupIntervalMs: ensurePositiveInt(readRequiredIntEnv("ARTICLE_CLEAN_INTERVAL_MS"), {
    name: "ARTICLE_CLEAN_INTERVAL_MS",
  }),
};

module.exports = {
  chatConfig,
  chatTimeContextConfig,
  chatMemoryConfig,
  chatGistConfig,
  llmConfig,
  logConfig,
  articleConfig,
};
