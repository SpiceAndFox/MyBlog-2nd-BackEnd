const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryProviderConfig } = require("../../../modules/memory/configuration");
const { PROPOSER_IDS } = require("../../../modules/memory/config/loadProviderConfig");
const { buildStructuredHttpRequest } = require("../../../modules/memory/infrastructure/providers/transport/structuredHttpRequest");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");

function env(overrides = {}) {
  return {
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-object",
    CHAT_MEMORY_V2_PROVIDER_PROFILE: "bai",
    CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://api.b.ai/v1",
    CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "glm-5.3-flash",
    CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: "low",
    CHAT_MEMORY_V2_PROVIDER_THINKING_MODE: "",
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: "{}",
    CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "256000",
    CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "25600",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    proposer: "todoProposer", systemPrompt: "Return JSON", userPayload: {},
    responseSchema: { name: "bai_probe", strict: true, schema: {
      type: "object", required: ["ids"], additionalProperties: false,
      properties: { ids: { type: "array", uniqueItems: true, items: { type: "integer" } } },
    } },
    ...overrides,
  };
}

test("B.AI GLM low applies to every proposer with JSON Object and the original local schema", () => {
  const config = loadMemoryProviderConfig(env());
  for (const proposer of PROPOSER_IDS) {
    const req = request({ proposer });
    const original = structuredClone(req.responseSchema);
    const { endpoint, body } = buildStructuredHttpRequest(config, req);
    assert.equal(endpoint, "https://api.b.ai/v1/chat/completions");
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.max_tokens, 25600);
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.ok(body.messages[0].content.includes(JSON.stringify(original.schema)));
    assert.deepEqual(req.responseSchema, original);
    for (const field of ["thinking", "reasoning", "tools", "max_completion_tokens"]) {
      assert.equal(Object.hasOwn(body, field), false);
    }
  }
});

test("B.AI requires explicit supported effort globally and in proposer overrides", () => {
  for (const effort of ["low", "high", "max"]) {
    const config = loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: effort }));
    assert.equal(buildStructuredHttpRequest(config, request()).body.reasoning_effort, effort);
  }
  for (const effort of ["", "none", "minimal", "medium", "xhigh"]) {
    assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: effort })), /REASONING_EFFORT|mandatory/);
  }
  for (const effort of ["medium", "none", null]) {
    assert.throws(() => loadMemoryProviderConfig(env({
      CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: JSON.stringify({ episodeProposer: { reasoningEffort: effort } }),
    })), /REASONING_EFFORT|mandatory/);
  }
  const config = loadMemoryProviderConfig(env({
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: JSON.stringify({ profileRelationshipProposer: { reasoningEffort: "high" } }),
  }));
  assert.equal(buildStructuredHttpRequest(config, request({ proposer: "relationshipProposer" })).body.reasoning_effort, "high");
  assert.equal(buildStructuredHttpRequest(config, request()).body.reasoning_effort, "low");
});

test("B.AI model rules require exact IDs and remain isolated from other gateways", () => {
  for (const model of ["vendor/glm-5.3-flash", "GLM-5.3-Flash", "glm-5.3-flash:free", "other-model"]) {
    assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_MODEL: model })), /No reasoning encoding/);
  }
  assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_PROFILE: "generic" })), /No reasoning encoding/);
  assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-schema" })), /does not support configured output mode json_schema/);
});

test("B.AI preview matches transport on initial and repair requests and ignores unused thinking settings", async () => {
  // reasoning-effort consumes effort only, retaining mixed-model configuration semantics.
  for (const thinkingMode of ["", "enabled", "disabled"]) {
    const config = loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_THINKING_MODE: thinkingMode }));
    for (const repairContext of [null, { assistantOutput: '{"ids":[1,1]}', userMessage: "Return unique IDs" }]) {
      const req = request({ repairContext });
      const preview = buildStructuredHttpRequest(config, req);
      let sent;
      const invoke = createStructuredTransport(config, { fetchImpl: async (url, options) => {
        sent = { url, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: {
          content: '{"ids":[1]}', reasoning_content: "Private reasoning is not the JSON output",
        } }] }) };
      } });
      const result = await invoke(req);
      assert.equal(sent.url, preview.endpoint);
      assert.deepEqual(sent.body, preview.body);
      assert.equal(sent.body.reasoning_effort, "low");
      assert.equal(Object.hasOwn(sent.body, "thinking"), false);
      assert.equal(result.rawSchemaValid, true);
      assert.deepEqual(result.output, { ids: [1] });
      assert.deepEqual(result.providerPolicy, preview.providerPolicy);
    }
  }
});

test("B.AI JSON Object responses still enforce the complete local schema", async () => {
  const invoke = createStructuredTransport(loadMemoryProviderConfig(env()), {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{
      finish_reason: "stop", message: { content: '{"ids":[1,1]}' },
    }] }) }),
  });
  const result = await invoke(request());
  assert.equal(result.rawSchemaValid, false);
  assert.ok(result.outputSchemaErrors.length > 0);
});
