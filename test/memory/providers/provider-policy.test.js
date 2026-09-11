const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryProviderConfig } = require("../../../modules/memory/configuration");
const { resolveMemoryProviderRequestPolicy } = require("../../../modules/memory/infrastructure/providers/policies/resolveProviderPolicy");
const { buildStructuredHttpRequest, chatCompletionsEndpoint } = require("../../../modules/memory/infrastructure/providers/transport/structuredHttpRequest");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { stripUniqueItems } = require("../../../modules/memory/infrastructure/providers/transport/schemaPolicies");

function config(overrides = {}) {
  return {
    adapter: "openai-compatible-json-schema", profile: "generic",
    baseUrl: "https://gateway.test/v1", apiKey: "test-key", model: "model-a",
    timeoutMs: 1000, maxInputTokens: 100_000, maxOutputTokens: 1024,
    ...overrides,
  };
}

function env(overrides = {}) {
  return {
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-schema",
    CHAT_MEMORY_V2_PROVIDER_PROFILE: "generic",
    CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://gateway.test/v1",
    CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "model-a",
    CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "100000",
    CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "1024",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    proposer: "todoProposer", systemPrompt: "Return JSON", userPayload: {},
    responseSchema: { name: "probe", strict: true, schema: {
      type: "object", required: ["ids"], additionalProperties: false,
      properties: { ids: { type: "array", uniqueItems: true, items: { type: "integer" } } },
    } },
    ...overrides,
  };
}

test("generic unknown models preserve schema and send no inferred reasoning controls", () => {
  const loaded = loadMemoryProviderConfig(env());
  const req = request();
  const body = buildStructuredHttpRequest(loaded, req).body;
  assert.deepEqual(body.response_format.json_schema, req.responseSchema);
  for (const key of ["thinking", "reasoning", "reasoning_effort"]) assert.equal(Object.hasOwn(body, key), false);
  assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: "high" })), /No reasoning encoding configured/);
});

test("full completion URLs and base URLs resolve to one endpoint", () => {
  for (const suffix of ["", "/", "/chat/completions", "/chat/completions/"]) {
    assert.equal(chatCompletionsEndpoint(`https://gateway.test/v1${suffix}`), "https://gateway.test/v1/chat/completions");
  }
  assert.equal(chatCompletionsEndpoint("https://proxy.test/prefix/v1/"), "https://proxy.test/prefix/v1/chat/completions");
});

test("the same model uses its gateway encoding without matching partial model IDs", () => {
  const opencode = config({ profile: "opencode-go", model: "mimo-v2.5", thinkingMode: "enabled", reasoningEffort: "high" });
  assert.deepEqual(buildStructuredHttpRequest(opencode, request()).body.thinking, { type: "enabled" });
  const router = buildStructuredHttpRequest({ ...opencode, profile: "openrouter" }, request()).body;
  assert.deepEqual(router.reasoning, { effort: "high" });
  assert.equal(Object.hasOwn(router, "thinking"), false);
  for (const model of ["vendor/mimo-v2.5", "MIMO-V2.5", "mimo-v2.5:free"]) {
    const body = buildStructuredHttpRequest({ ...opencode, model }, request()).body;
    assert.equal(body.reasoning_effort, "high");
    assert.equal(Object.hasOwn(body, "thinking"), false);
  }
});

test("model rules specialize defaults; proposers select settings without changing capabilities", () => {
  const loaded = loadMemoryProviderConfig(env({
    CHAT_MEMORY_V2_PROVIDER_PROFILE: "opencode-go",
    CHAT_MEMORY_V2_PROVIDER_POLICY_JSON: JSON.stringify({ schemaPolicy: "preserve" }),
    CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON: JSON.stringify({
      "mimo-v2.5": { outputTokenField: "max_completion_tokens", thinkingModes: ["enabled"] },
      "model-a": { reasoningEfforts: ["low", "high"] },
    }),
    CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: "low",
    CHAT_MEMORY_V2_PROVIDER_THINKING_MODE: "disabled",
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: JSON.stringify({
      profileRelationshipProposer: { model: "mimo-v2.5", thinkingMode: "enabled" },
      userProfileProposer: { model: "model-a", reasoningEffort: "high" },
    }),
  }));
  const relationship = buildStructuredHttpRequest(loaded, request({ proposer: "relationshipProposer" })).body;
  assert.equal(relationship.model, "mimo-v2.5");
  assert.deepEqual(relationship.thinking, { type: "enabled" });
  assert.equal(relationship.max_completion_tokens, 1024);
  assert.equal(Object.hasOwn(relationship, "max_tokens"), false);
  assert.equal(relationship.response_format.json_schema.schema.properties.ids.uniqueItems, true);
  const user = buildStructuredHttpRequest(loaded, request({ proposer: "userProfileProposer" })).body;
  assert.equal(user.model, "model-a");
  assert.equal(user.reasoning_effort, "high");
  assert.equal(buildStructuredHttpRequest(loaded, request()).body.reasoning_effort, "low");
  assert.throws(() => resolveMemoryProviderRequestPolicy({ ...loaded, proposerModels: {
    todoProposer: { reasoningEffort: "max" },
  } }, "todoProposer"), /REASONING_EFFORT.*low, high/);
});

test("gateway defaults cannot accidentally erase a built-in model exception", () => {
  const cfg = config({ profile: "opencode-go", model: "mimo-v2.5", thinkingMode: "enabled",
    policy: { reasoningEncoding: "reasoning-effort" } });
  assert.deepEqual(buildStructuredHttpRequest(cfg, request()).body.thinking, { type: "enabled" });
  const custom = { ...cfg, reasoningEffort: "low", modelRules: { "mimo-v2.5": { reasoningEncoding: "openrouter" } } };
  assert.deepEqual(buildStructuredHttpRequest(custom, request()).body.reasoning, { effort: "low" });
});

test("a non-reasoning proposer can clear inherited controls without affecting other models", () => {
  const values = env({
    CHAT_MEMORY_V2_PROVIDER_POLICY_JSON: '{"reasoningEncoding":"reasoning-effort"}',
    CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: "high",
    CHAT_MEMORY_V2_PROVIDER_THINKING_MODE: "enabled",
    CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON: '{"plain-model":{"reasoningEncoding":"none"}}',
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: JSON.stringify({
      profileRelationshipProposer: { model: "plain-model", reasoningEffort: null, thinkingMode: null },
    }),
  });
  const loaded = loadMemoryProviderConfig(values);
  const plain = buildStructuredHttpRequest(loaded, request({ proposer: "relationshipProposer" })).body;
  assert.equal(plain.model, "plain-model");
  assert.equal(Object.hasOwn(plain, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(plain, "thinking"), false);
  assert.equal(buildStructuredHttpRequest(loaded, request()).body.reasoning_effort, "high");
  values.CHAT_MEMORY_V2_PROPOSER_MODELS_JSON = '{"todoProposer":{"reasoningEffort":null}}';
  assert.throws(() => loadMemoryProviderConfig(values), /REASONING_EFFORT/);
});

test("policy declarations reject typos, invalid capabilities and proposer policy injection", () => {
  for (const value of ['[]', 'null', '{', '{"typo":true}', '{"reasoningEncoding":"auto"}',
    '{"outputModes":[]}', '{"outputModes":["json_object","json_object"]}', '{"thinkingModes":["sometimes"]}']) {
    assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_POLICY_JSON: value })), /CHAT_MEMORY_V2_PROVIDER_POLICY_JSON/);
  }
  for (const value of ['[]', '{" model-a":{}}', '{"model-a":{"outputTokenField":"tokens"}}']) {
    assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON: value })), /CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON/);
  }
  assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROVIDER_PROFILE: "xiaomimimo" })), /PROVIDER_PROFILE/);
  assert.throws(() => loadMemoryProviderConfig(env({ CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: '{"todoProposer":{"policy":{}}}' })), /unsupported key: policy/);
});

test("all effective proposer models are validated on startup without output-mode fallback", () => {
  const values = env({
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: '{"episodeProposer":"object-only"}',
    CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON: '{"object-only":{"outputModes":["json_object"]}}',
  });
  assert.throws(() => loadMemoryProviderConfig(values), /object-only.*json_schema/);
  values.CHAT_MEMORY_V2_PROVIDER_ADAPTER = "openai-compatible-json-object";
  assert.doesNotThrow(() => loadMemoryProviderConfig(values));
});

test("OpenRouter serializes off, effort and mandatory-reasoning constraints", () => {
  const cfg = config({ profile: "openrouter" });
  const body = (settings) => buildStructuredHttpRequest({ ...cfg, ...settings }, request()).body;
  assert.equal(Object.hasOwn(body({}), "reasoning"), false);
  assert.deepEqual(body({ thinkingMode: "enabled" }).reasoning, { enabled: true });
  assert.deepEqual(body({ thinkingMode: "disabled", reasoningEffort: "high" }).reasoning, { enabled: false });
  assert.deepEqual(body({ reasoningEffort: "high" }).reasoning, { effort: "high" });
  assert.throws(() => body({ thinkingMode: "enabled", reasoningEffort: "none" }), /conflicts/);
  for (const settings of [{ thinkingMode: "disabled" }, { reasoningEffort: "none" }]) {
    assert.throws(() => body({ ...settings, modelRules: { "model-a": { thinkingModes: ["enabled"] } } }), /THINKING_MODE|mandatory/);
  }
  assert.throws(() => body({ reasoningEffort: "high", modelRules: { "model-a": { reasoningEfforts: [] } } }), /REASONING_EFFORT/);
  for (const reasoningEncoding of ["reasoning-effort", "openrouter"]) {
    assert.throws(() => body({ reasoningEffort: "high", policy: { reasoningEncoding, thinkingModes: ["disabled"] } }), /THINKING_MODE/);
  }
});

test("preview and sent requests agree across adapters, gateway profiles and repair policies", async () => {
  for (const adapter of ["openai-compatible-json-schema", "openai-compatible-json-object"]) {
    for (const profile of ["generic", "opencode-go", "openrouter"]) {
      const cfg = config({ adapter, profile,
        ...(profile === "generic" ? {} : { reasoningEffort: "high" }),
        policy: { repairRole: "user-diagnostic", outputTokenField: "max_completion_tokens" },
      });
      for (const repairContext of [null, { assistantOutput: '{"ids":[]}', userMessage: "Repair the candidate" }]) {
        const req = request({ repairContext });
        const preview = buildStructuredHttpRequest(cfg, req);
        let sent;
        const invoke = createStructuredTransport(cfg, { fetchImpl: async (url, options) => {
          sent = { url, body: JSON.parse(options.body) };
          return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"ids":[1]}' } }] }) };
        } });
        const result = await invoke(req);
        assert.equal(sent.url, preview.endpoint);
        assert.deepEqual(sent.body, preview.body);
        assert.deepEqual(result.providerPolicy, preview.providerPolicy);
        assert.equal(result.rawSchemaValid, true);
        if (repairContext) {
          assert.deepEqual(sent.body.messages.map((message) => message.role), ["system", "user", "user", "user"]);
          assert.match(sent.body.messages[2].content, /quoted diagnostic data/);
        }
      }
    }
  }
});

test("schema stripping preserves literal values, property names and the original schema", () => {
  const schema = {
    type: "object", properties: {
      uniqueItems: { type: "boolean" },
      literal: { const: { uniqueItems: true }, enum: [{ uniqueItems: false }] },
      ids: { type: "array", uniqueItems: true, items: { type: "integer" } },
    },
  };
  const original = structuredClone(schema);
  const compiled = stripUniqueItems(schema);
  assert.deepEqual(schema, original);
  assert.deepEqual(compiled.properties.uniqueItems, schema.properties.uniqueItems);
  assert.deepEqual(compiled.properties.literal, schema.properties.literal);
  assert.equal(Object.hasOwn(compiled.properties.ids, "uniqueItems"), false);
  assert.match(compiled.properties.ids.description, /unique/);
});

test("local schema validation enforces stripped uniqueness for both output modes", async () => {
  for (const adapter of ["openai-compatible-json-schema", "openai-compatible-json-object"]) {
    const invoke = createStructuredTransport(config({ adapter, profile: "opencode-go", reasoningEffort: "none" }), {
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"ids":[1,1]}' } }] }) }),
    });
    const result = await invoke(request());
    assert.equal(result.rawSchemaValid, false);
    assert.ok(result.outputSchemaErrors.length > 0);
  }
});

test("legacy adapter aliases retain wire behavior while exposing canonical metadata", () => {
  for (const mode of ["json-schema", "json-object"]) {
    const legacy = buildStructuredHttpRequest(config({ adapter: `opencode-go-${mode}`, profile: undefined, reasoningEffort: "none" }), request());
    const canonical = buildStructuredHttpRequest(config({ adapter: `openai-compatible-${mode}`, profile: "opencode-go", reasoningEffort: "none" }), request());
    assert.deepEqual(legacy, canonical);
  }
  const legacy = buildStructuredHttpRequest(config({ adapter: "openai-json-schema", thinkingMode: "enabled", reasoningEffort: "high" }), request());
  assert.deepEqual(legacy, buildStructuredHttpRequest(config(), request()));
});
