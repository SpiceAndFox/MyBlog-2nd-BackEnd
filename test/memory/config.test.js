const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryV2Config } = require("../../modules/memory/config/loadConfig");
const { loadMemoryProviderConfig } = require("../../modules/memory/config/loadProviderConfig");

test("v2 config is inert while feature is disabled", () => assert.deepEqual(loadMemoryV2Config({}), { enabled: false }));
test("v2 config fails explicitly when enabled configuration is incomplete", () => {
  assert.throws(() => loadMemoryV2Config({ CHAT_MEMORY_V2_ENABLED: "true" }), /Missing required env/);
});

function validEnv() {
  const env = { CHAT_MEMORY_V2_ENABLED: "true" };
  const sections = ["TODOS", "STANDING_AGREEMENTS", "RECENT_EPISODES", "MILESTONES", "WORLD_FACTS", "USER_PROFILE", "ASSISTANT_PROFILE", "RELATIONSHIP"];
  for (const section of sections) {
    env[`CHAT_MEMORY_V2_${section}_MAX_ITEMS`] = "20";
    env[`CHAT_MEMORY_V2_${section}_MAX_RENDERED_CHARS`] = "2000";
  }
  const targets = ["SCENE", "TODOS", "STANDING_AGREEMENTS", "EPISODES", "PROFILE_RELATIONSHIP", "WORLD_FACTS"];
  for (const target of targets) {
    env[`CHAT_MEMORY_V2_${target}_LAG_THRESHOLD`] = "2";
    env[`CHAT_MEMORY_V2_${target}_CONTEXT_WINDOW`] = "6";
  }
  Object.assign(env, {
    CHAT_MEMORY_V2_SCENE_MAX_RENDERED_CHARS: "1000", CHAT_MEMORY_V2_SCENE_TTL_MS: "86400000",
    CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_ITEMS: "10", CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_CHARS: "1000",
    CHAT_MEMORY_V2_GAP_BRIDGE_MAX_RAW_CHARS: "10000", CHAT_MEMORY_V2_GAP_BRIDGE_RETAINED_MESSAGES: "10",
    CHAT_MEMORY_V2_QUOTE_MATCH_THRESHOLD: "0.75", CHAT_MEMORY_V2_PROVIDER_RETRY_MAX: "2",
    CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX: "1",
    CHAT_MEMORY_V2_PROVIDER_BACKOFF_BASE_MS: "1000", CHAT_MEMORY_V2_PROVIDER_BACKOFF_MAX_MS: "10000",
    CHAT_MEMORY_V2_HALT_AFTER_CONSECUTIVE_ERRORS: "3", CHAT_MEMORY_V2_COMPACTION_RETRY_MAX: "2",
    CHAT_MEMORY_V2_SNAPSHOT_RETENTION_DAYS: "30", CHAT_MEMORY_V2_EVENT_RETENTION_DAYS: "30",
    CHAT_MEMORY_V2_TASK_RETENTION_DAYS: "30", CHAT_MEMORY_V2_OPS_LOG_RETENTION_DAYS: "30",
    CHAT_MEMORY_V2_DEBUG_RETENTION_DAYS: "7", CHAT_MEMORY_V2_ALERT_DEBOUNCE_MS: "0", CHAT_MEMORY_V2_RECOVERY_STABLE_MS: "0",
    CHAT_MEMORY_V2_PROJECTION_POLL_INTERVAL_MS: "60000", CHAT_MEMORY_V2_TASK_POLL_INTERVAL_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-json-schema", CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://example.test/v1/", CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "structured-model", CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "60000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "1000000", CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "8192",
  });
  return env;
}

test("v2 config requires an explicit structured-output adapter", () => {
  const env = validEnv();
  const config = loadMemoryV2Config(env);
  assert.equal(config.provider.model, "structured-model");
  assert.equal(config.provider.adapter, "openai-json-schema");
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "prompt-and-parse";
  assert.throws(() => loadMemoryV2Config(env), /PROVIDER_ADAPTER must be one of/);
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "openai-json-schema";
  env.CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS = "999999";
  assert.throws(() => loadMemoryV2Config(env), /1000000/);
});

test("provider config is independently loadable and never falls back to chat provider env", () => {
  const env = validEnv();
  delete env.CHAT_MEMORY_V2_ENABLED;
  assert.equal(loadMemoryProviderConfig(env).baseUrl, "https://example.test/v1/");
  delete env.CHAT_MEMORY_V2_PROVIDER_API_KEY;
  env.DEEPSEEK_API_KEY = "must-not-be-used";
  assert.throws(() => loadMemoryProviderConfig(env), /CHAT_MEMORY_V2_PROVIDER_API_KEY/);
});

test("DeepSeek provider config requires thinking to be explicitly disabled", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "deepseek-strict-tools";
  env.CHAT_MEMORY_V2_PROVIDER_BASE_URL = "https://api.deepseek.com/beta";
  assert.throws(() => loadMemoryProviderConfig(env), /PROVIDER_THINKING_MODE/);
  env.CHAT_MEMORY_V2_PROVIDER_THINKING_MODE = "disabled";
  assert.equal(loadMemoryProviderConfig(env).thinkingMode, "disabled");
  env.CHAT_MEMORY_V2_PROVIDER_THINKING_MODE = "sometimes";
  assert.throws(() => loadMemoryProviderConfig(env), /must be disabled/);
  env.CHAT_MEMORY_V2_PROVIDER_THINKING_MODE = "enabled";
  assert.throws(() => loadMemoryProviderConfig(env), /must be disabled/);
});

test("schema-invalid retry is strictly bounded to at most one", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX = "2";
  assert.throws(() => loadMemoryV2Config(env), /must be 0 or 1/);
});
