const test = require("node:test");
const assert = require("node:assert/strict");
const { createGatewayRegistry, gatewayRegistry } = require("../../../modules/memory/infrastructure/providers/gateways/registry");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { loadMemoryProviderConfig: parseProviderConfig } = require("../../../modules/memory/config/loadProviderConfig");
const { loadMemoryProviderConfig } = require("../../../modules/memory/admin");

test("gateway catalog registers defaults and exact model exceptions from source files", () => {
  const opencode = gatewayRegistry.get("opencode-go");
  assert.equal(opencode.defaults.reasoningEncoding, "reasoning-effort");
  assert.equal(opencode.models["mimo-v2.5"].reasoningEncoding, "thinking");
  assert.equal(opencode.models["mimo-v2.5-pro"].reasoningEncoding, "thinking");
  assert.equal(Object.hasOwn(opencode.models, "vendor/mimo-v2.5"), false);
  assert.equal(Object.hasOwn(gatewayRegistry.get("openrouter").models, "mimo-v2.5"), false);
  assert.deepEqual(gatewayRegistry.get("generic").defaults, {});
  assert.deepEqual(gatewayRegistry.get("bai").defaults, {});
  assert.equal(gatewayRegistry.get("bai").models["glm-5.3-flash"].reasoningEncoding, "reasoning-effort");
  assert.equal(Object.hasOwn(gatewayRegistry.get("generic").models, "glm-5.3-flash"), false);
});

test("duplicate gateway and model registrations fail; the same ID across gateways is valid", () => {
  const model = { id: "model-a", policy: { reasoningEncoding: "thinking" } };
  const profile = { id: "gateway-a", defaults: {}, models: [model] };
  assert.throws(() => createGatewayRegistry([profile, profile]), /Duplicate gateway/);
  assert.throws(() => createGatewayRegistry([{ ...profile, models: [model, model] }]), /Duplicate model/);
  const registry = createGatewayRegistry([profile, {
    id: "gateway-b", defaults: {}, models: [{ id: "model-a", policy: { reasoningEncoding: "openrouter" } }],
  }]);
  assert.equal(registry.get("gateway-a").models["model-a"].reasoningEncoding, "thinking");
  assert.equal(registry.get("gateway-b").models["model-a"].reasoningEncoding, "openrouter");
});

test("invalid source declarations fail on registration and cannot mutate registered rules", () => {
  const profile = { id: "gateway-a", defaults: { outputModes: ["json_object"] }, models: [] };
  assert.throws(() => createGatewayRegistry([{ ...profile, id: " gateway-a" }]), /exact, non-empty ID/);
  assert.throws(() => createGatewayRegistry([{ ...profile, models: null }]), /models array/);
  assert.throws(() => createGatewayRegistry([{ ...profile, defaults: { outputMode: "json_object" } }]), /unsupported key/);
  assert.throws(() => createGatewayRegistry([{ ...profile, models: [{ id: "model-a", policy: { reasoningEncoding: "auto" } }] }]), /reasoningEncoding/);
  const registry = createGatewayRegistry([profile]);
  profile.defaults.outputModes.push("json_schema");
  assert.deepEqual(registry.get("gateway-a").defaults.outputModes, ["json_object"]);
  assert.throws(() => registry.get("gateway-a").defaults.outputModes.push("json_schema"), TypeError);
});

test("public loading validates capabilities after parsing, without introducing parsing dependencies", () => {
  const env = {
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-object",
    CHAT_MEMORY_V2_PROVIDER_PROFILE: "unknown-gateway",
    CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://gateway.test/v1",
    CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "model-a",
    CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "100000",
    CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "1024",
  };
  assert.equal(parseProviderConfig(env).profile, "unknown-gateway");
  assert.throws(() => loadMemoryProviderConfig(env), /PROVIDER_PROFILE/);
  env.CHAT_MEMORY_V2_PROVIDER_PROFILE = "generic";
  env.CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON = '{"unused-model":{"unknownPolicy":true}}';
  assert.doesNotThrow(() => parseProviderConfig(env));
  assert.throws(() => loadMemoryProviderConfig(env), /unused-model.*unsupported key/);
});

test("transport initialization validates all injected proposer models before dispatch", () => {
  let calls = 0;
  const config = {
    adapter: "openai-compatible-json-object", profile: "opencode-go",
    baseUrl: "https://gateway.test/v1", apiKey: "test-key", model: "hy3",
    reasoningEffort: "high", proposerModels: { episodeProposer: "mimo-v2.5" },
    maxInputTokens: 100_000, maxOutputTokens: 1024, timeoutMs: 1000,
  };
  assert.throws(() => createStructuredTransport(config, { fetchImpl: async () => { calls++; } }), /THINKING_MODE.*mimo-v2.5/);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => createStructuredTransport({ ...config, thinkingMode: "enabled" }));
});
