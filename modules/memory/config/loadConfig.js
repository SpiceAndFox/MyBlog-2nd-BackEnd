const { TARGET_KEYS, ITEM_SECTIONS } = require("../contracts/constants");
const { loadMemoryProviderConfig } = require("./loadProviderConfig");

function parseBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`Env ${name} must be a boolean`);
}
function requiredInt(env, name, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") throw new Error(`Missing required env: ${name}`);
  if (!/^-?\d+$/.test(String(raw).trim())) throw new Error(`Env ${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Env ${name} must be a safe integer >= ${min}`);
  return value;
}
function requiredFloat(env, name, { min, max } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") throw new Error(`Missing required env: ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Env ${name} must be between ${min} and ${max}`);
  return value;
}
function envName(value) { return value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(); }

function loadMemoryV2Config(env = process.env) {
  const enabled = parseBool(env, "CHAT_MEMORY_V2_ENABLED", false);
  if (!enabled) return Object.freeze({ enabled: false });
  const sectionBudgets = {};
  for (const section of ITEM_SECTIONS) {
    const prefix = `CHAT_MEMORY_V2_${envName(section)}`;
    sectionBudgets[section] = Object.freeze({ maxItems: requiredInt(env, `${prefix}_MAX_ITEMS`, { min: 1 }), maxRenderedChars: requiredInt(env, `${prefix}_MAX_RENDERED_CHARS`, { min: 1 }) });
  }
  const targets = {};
  for (const target of TARGET_KEYS) {
    const prefix = `CHAT_MEMORY_V2_${envName(target)}`;
    const lagThreshold = requiredInt(env, `${prefix}_LAG_THRESHOLD`, { min: 1 });
    const contextWindow = requiredInt(env, `${prefix}_CONTEXT_WINDOW`, { min: 1 });
    if (contextWindow < lagThreshold) throw new Error(`Env ${prefix}_CONTEXT_WINDOW must be >= ${prefix}_LAG_THRESHOLD`);
    targets[target] = Object.freeze({ lagThreshold, contextWindow });
  }
  const retryMax = requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_RETRY_MAX");
  const schemaInvalidRetryMax = requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX");
  if (schemaInvalidRetryMax > 1) throw new Error("CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX must be 0 or 1");
  const haltAfterConsecutiveErrors = requiredInt(env, "CHAT_MEMORY_V2_HALT_AFTER_CONSECUTIVE_ERRORS", { min: 1 });
  if (retryMax >= haltAfterConsecutiveErrors) throw new Error("CHAT_MEMORY_V2_PROVIDER_RETRY_MAX must be less than CHAT_MEMORY_V2_HALT_AFTER_CONSECUTIVE_ERRORS");
  return Object.freeze({
    enabled: true, schemaVersion: 2, sectionBudgets: Object.freeze(sectionBudgets), targets: Object.freeze(targets),
    scene: Object.freeze({ maxRenderedChars: requiredInt(env, "CHAT_MEMORY_V2_SCENE_MAX_RENDERED_CHARS", { min: 1 }), ttlMs: requiredInt(env, "CHAT_MEMORY_V2_SCENE_TTL_MS", { min: 1 }) }),
    overdueTodos: Object.freeze({ maxRenderedItems: requiredInt(env, "CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_ITEMS", { min: 1 }), maxRenderedChars: requiredInt(env, "CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_CHARS", { min: 1 }) }),
    gapBridge: Object.freeze({ maxRawChars: requiredInt(env, "CHAT_MEMORY_V2_GAP_BRIDGE_MAX_RAW_CHARS", { min: 1 }), retainedMessages: requiredInt(env, "CHAT_MEMORY_V2_GAP_BRIDGE_RETAINED_MESSAGES", { min: 1 }) }),
    quote: Object.freeze({ algorithm: "equal_window_levenshtein", threshold: requiredFloat(env, "CHAT_MEMORY_V2_QUOTE_MATCH_THRESHOLD", { min: 0, max: 1 }), maxCodePoints: 200 }),
    providerRecovery: Object.freeze({ retryMax, schemaInvalidRetryMax, backoffBaseMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_BACKOFF_BASE_MS", { min: 1 }), backoffMaxMs: requiredInt(env, "CHAT_MEMORY_V2_PROVIDER_BACKOFF_MAX_MS", { min: 1 }), haltAfterConsecutiveErrors }),
    compaction: Object.freeze({ retryMax: requiredInt(env, "CHAT_MEMORY_V2_COMPACTION_RETRY_MAX") }),
    retention: Object.freeze({ snapshotDays: requiredInt(env, "CHAT_MEMORY_V2_SNAPSHOT_RETENTION_DAYS", { min: 1 }), eventDays: requiredInt(env, "CHAT_MEMORY_V2_EVENT_RETENTION_DAYS", { min: 1 }), taskDays: requiredInt(env, "CHAT_MEMORY_V2_TASK_RETENTION_DAYS", { min: 1 }), opsLogDays: requiredInt(env, "CHAT_MEMORY_V2_OPS_LOG_RETENTION_DAYS", { min: 1 }), debugDays: requiredInt(env, "CHAT_MEMORY_V2_DEBUG_RETENTION_DAYS") }),
    health: Object.freeze({ alertDebounceMs: requiredInt(env, "CHAT_MEMORY_V2_ALERT_DEBOUNCE_MS"), recoveryStableMs: requiredInt(env, "CHAT_MEMORY_V2_RECOVERY_STABLE_MS") }),
    tasks: Object.freeze({ pollIntervalMs: requiredInt(env, "CHAT_MEMORY_V2_TASK_POLL_INTERVAL_MS", { min: 250 }) }),
    projections: Object.freeze({ pollIntervalMs: requiredInt(env, "CHAT_MEMORY_V2_PROJECTION_POLL_INTERVAL_MS", { min: 1000 }) }),
    provider: loadMemoryProviderConfig(env),
  });
}
module.exports = { loadMemoryV2Config };
