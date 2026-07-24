const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryV2Config } = require("../../../modules/memory/config/loadConfig");
const { loadMemoryProviderConfig, resolveMemoryProviderModel, resolveMemoryProviderReasoningEffort } = require("../../../modules/memory/config/loadProviderConfig");

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
  const targets = {
    SCENE: [4, 16],
    TODOS: [8, 48],
    STANDING_AGREEMENTS: [16, 64],
    EPISODES: [32, 96],
    PROFILE_RELATIONSHIP: [32, 64],
    WORLD_FACTS: [16, 96],
  };
  for (const [target, [lagThreshold, contextWindow]] of Object.entries(targets)) {
    env[`CHAT_MEMORY_V2_${target}_LAG_THRESHOLD`] = String(lagThreshold);
    env[`CHAT_MEMORY_V2_${target}_CONTEXT_WINDOW`] = String(contextWindow);
  }
  Object.assign(env, {
    CHAT_MEMORY_V2_SCENE_MAX_RENDERED_CHARS: "1000", CHAT_MEMORY_V2_SCENE_TTL_MS: "86400000",
    CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_ITEMS: "10", CHAT_MEMORY_V2_OVERDUE_TODOS_MAX_RENDERED_CHARS: "1000",
    CHAT_MEMORY_V2_GAP_BRIDGE_MAX_RAW_CHARS: "10000", CHAT_MEMORY_V2_GAP_BRIDGE_RETAINED_MESSAGES: "10",
    CHAT_MEMORY_V2_PROVIDER_RETRY_MAX: "2",
    CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX: "1",
    CHAT_MEMORY_V2_PROVIDER_BACKOFF_BASE_MS: "1000", CHAT_MEMORY_V2_PROVIDER_BACKOFF_MAX_MS: "10000",
    CHAT_MEMORY_V2_HALT_AFTER_CONSECUTIVE_ERRORS: "3", CHAT_MEMORY_V2_COMPACTION_RETRY_MAX: "2",
    CHAT_MEMORY_V2_HYGIENE_HIGH_WATERMARK_PERCENT: "70", CHAT_MEMORY_V2_HYGIENE_MIN_ITEM_DELTA: "5",
    CHAT_MEMORY_V2_SNAPSHOT_RETENTION_DAYS: "30", CHAT_MEMORY_V2_EVENT_RETENTION_DAYS: "30",
    CHAT_MEMORY_V2_TASK_RETENTION_DAYS: "30", CHAT_MEMORY_V2_OPS_LOG_RETENTION_DAYS: "30",
    CHAT_MEMORY_V2_DEBUG_RETENTION_DAYS: "7", CHAT_MEMORY_V2_ALERT_DEBOUNCE_MS: "0", CHAT_MEMORY_V2_RECOVERY_STABLE_MS: "0",
    CHAT_MEMORY_V2_PROJECTION_POLL_INTERVAL_MS: "60000", CHAT_MEMORY_V2_TASK_POLL_INTERVAL_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-json-schema", CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://example.test/v1/", CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "structured-model", CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "60000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "1000000", CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "8192",
    CHAT_MEMORY_V2_PROVIDER_CONCURRENCY: "2", CHAT_MEMORY_V2_PROVIDER_QUEUE_MAX: "32",
  });
  return env;
}

test("v2 config requires an explicit structured-output adapter", () => {
  const env = validEnv();
  const config = loadMemoryV2Config(env);
  assert.equal(config.provider.model, "structured-model");
  assert.equal(config.provider.adapter, "openai-json-schema");
  assert.deepEqual(config.targets, {
    scene: { lagThreshold: 4, contextWindow: 16 },
    todos: { lagThreshold: 8, contextWindow: 48 },
    standingAgreements: { lagThreshold: 16, contextWindow: 64 },
    episodes: { lagThreshold: 32, contextWindow: 96 },
    profileRelationship: { lagThreshold: 32, contextWindow: 64 },
    worldFacts: { lagThreshold: 16, contextWindow: 96 },
  });
  assert.deepEqual(config.hygiene, { highWatermarkPercent: 70, minItemDelta: 5 });
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "prompt-and-parse";
  assert.throws(() => loadMemoryV2Config(env), /PROVIDER_ADAPTER must be one of/);
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "openai-json-schema";
  env.CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS = "99999";
  assert.throws(() => loadMemoryV2Config(env), /100000/);
});

test("provider config is independently loadable and never falls back to chat provider env", () => {
  const env = validEnv();
  delete env.CHAT_MEMORY_V2_ENABLED;
  assert.equal(loadMemoryProviderConfig(env).baseUrl, "https://example.test/v1/");
  delete env.CHAT_MEMORY_V2_PROVIDER_API_KEY;
  env.DEEPSEEK_API_KEY = "must-not-be-used";
  assert.throws(() => loadMemoryProviderConfig(env), /CHAT_MEMORY_V2_PROVIDER_API_KEY/);
});

test("provider config supports validated per-proposer model overrides with a default fallback", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({
    currentStateProposer: "scene-model",
    profileRelationshipProposer: "profile-model",
  });
  const provider = loadMemoryProviderConfig(env);
  assert.deepEqual(provider.proposerModels, {
    currentStateProposer: "scene-model",
    profileRelationshipProposer: "profile-model",
  });
  assert.equal(resolveMemoryProviderModel(provider, "currentStateProposer"), "scene-model");
  assert.equal(resolveMemoryProviderModel(provider, "profileRelationshipProposer"), "profile-model");
  assert.equal(resolveMemoryProviderModel(provider, "userProfileProposer"), "profile-model");
  assert.equal(resolveMemoryProviderModel(provider, "assistantProfileProposer"), "profile-model");
  assert.equal(resolveMemoryProviderModel(provider, "relationshipProposer"), "profile-model");
  assert.equal(resolveMemoryProviderModel(provider, "todoProposer"), "structured-model");

  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({
    profileRelationshipProposer: "profile-model",
    relationshipProposer: "relationship-model",
  });
  assert.equal(resolveMemoryProviderModel(loadMemoryProviderConfig(env), "relationshipProposer"), "relationship-model");

  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = "not-json";
  assert.throws(() => loadMemoryProviderConfig(env), /must be valid JSON/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ unknownProposer: "model" });
  assert.throws(() => loadMemoryProviderConfig(env), /unsupported proposer/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: "  " });
  assert.throws(() => loadMemoryProviderConfig(env), /non-empty model id/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: 42 });
  assert.throws(() => loadMemoryProviderConfig(env), /non-empty model id/);
});

test("provider config accepts the OpenCode Go adapter without thinking mode env", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "opencode-go-json-schema";
  env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT = "none";
  const provider = loadMemoryProviderConfig(env);
  assert.equal(provider.adapter, "opencode-go-json-schema");
  assert.equal(provider.reasoningEffort, "none");
  assert.equal(provider.thinkingMode, undefined);
});

test("OpenCode Go provider config requires an explicit reasoning effort", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "opencode-go-json-schema";
  assert.throws(() => loadMemoryProviderConfig(env), /PROVIDER_REASONING_EFFORT must be one of/);
  env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT = "turbo";
  assert.throws(() => loadMemoryProviderConfig(env), /PROVIDER_REASONING_EFFORT must be one of/);
  env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT = "NONE";
  assert.equal(loadMemoryProviderConfig(env).reasoningEffort, "none");
});

test("provider config supports per-proposer model and reasoning effort overrides", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "opencode-go-json-schema";
  env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT = "none";
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({
    profileRelationshipProposer: { model: "deepseek-v4-pro", reasoningEffort: "high" },
    todoProposer: { reasoningEffort: "low" },
    episodeProposer: "hy3",
  });
  const provider = loadMemoryProviderConfig(env);
  assert.deepEqual(provider.proposerModels, {
    profileRelationshipProposer: { model: "deepseek-v4-pro", reasoningEffort: "high" },
    todoProposer: { reasoningEffort: "low" },
    episodeProposer: "hy3",
  });
  assert.equal(resolveMemoryProviderModel(provider, "episodeProposer"), "hy3");
  assert.equal(resolveMemoryProviderModel(provider, "todoProposer"), "structured-model");
  assert.equal(resolveMemoryProviderModel(provider, "relationshipProposer"), "deepseek-v4-pro");
  assert.equal(resolveMemoryProviderReasoningEffort(provider, "todoProposer"), "low");
  assert.equal(resolveMemoryProviderReasoningEffort(provider, "episodeProposer"), "none");
  assert.equal(resolveMemoryProviderReasoningEffort(provider, "relationshipProposer"), "high");
  assert.equal(resolveMemoryProviderReasoningEffort(provider, "userProfileProposer"), "high");
});

test("per-proposer override validation rejects malformed entries", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "opencode-go-json-schema";
  env.CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT = "none";
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: { model: "hy3", bogus: 1 } });
  assert.throws(() => loadMemoryProviderConfig(env), /unsupported key/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: { reasoningEffort: "turbo" } });
  assert.throws(() => loadMemoryProviderConfig(env), /must be one of/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: { model: "  " } });
  assert.throws(() => loadMemoryProviderConfig(env), /non-empty model id/);
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: {} });
  assert.throws(() => loadMemoryProviderConfig(env), /must override/);
});

test("reasoning effort overrides require the OpenCode Go adapter", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = JSON.stringify({ todoProposer: { reasoningEffort: "none" } });
  assert.throws(() => loadMemoryProviderConfig(env), /requires the opencode-go-json-schema adapter/);
});

test("DeepSeek provider config passes thinking mode through", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "deepseek-strict-tools";
  env.CHAT_MEMORY_V2_PROVIDER_BASE_URL = "https://api.deepseek.com/beta";
  assert.throws(() => loadMemoryProviderConfig(env), /PROVIDER_THINKING_MODE/);
  env.CHAT_MEMORY_V2_PROVIDER_THINKING_MODE = "disabled";
  assert.equal(loadMemoryProviderConfig(env).thinkingMode, "disabled");
  env.CHAT_MEMORY_V2_PROVIDER_THINKING_MODE = "ENABLED";
  assert.equal(loadMemoryProviderConfig(env).thinkingMode, "enabled");
});

test("schema-invalid retry budget is configurable", () => {
  const env = validEnv();
  env.CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX = "2";
  assert.equal(loadMemoryV2Config(env).providerRecovery.schemaInvalidRetryMax, 2);
});

test("v2-off is rejected as a production or rollback mode", () => {
  assert.throws(
    () => loadMemoryV2Config({ NODE_ENV: "production", CHAT_MEMORY_V2_ENABLED: "false" }),
    /not a supported production or rollback mode/,
  );
  assert.deepEqual(loadMemoryV2Config({ NODE_ENV: "test", CHAT_MEMORY_V2_ENABLED: "false" }), { enabled: false });
});
