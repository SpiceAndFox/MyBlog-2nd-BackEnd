const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryProviderConfig } = require("../../../modules/memory/configuration");
const { buildStructuredHttpRequest } = require("../../../modules/memory/infrastructure/providers/transport/structuredHttpRequest");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { buildProviderRequestPreviews } = require("../../../modules/memory/infrastructure/providers/diagnostics/providerRequestPreview");
const { envelope, profileEnvelope } = require("../support/provider-envelopes");

function config(overrides = {}) {
  return {
    adapter: "openai-compatible-json-object", profile: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "test-key", model: "glm-5.3-flash",
    reasoningEffort: "low", timeoutMs: 1000, maxInputTokens: 256000, maxOutputTokens: 25600,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    proposer: "episodeProposer", requestContext: { scope: { userId: 1, presetId: "private-preset" } },
    systemPrompt: "Return JSON", userPayload: { task: { taskId: "task-a" } },
    responseSchema: { name: "probe", strict: true, schema: {
      type: "object", properties: { ok: { const: true } }, required: ["ok"], additionalProperties: false,
    } },
    ...overrides,
  };
}

const built = (req = request(), cfg = config()) => buildStructuredHttpRequest(cfg, req);
const session = (req = request(), cfg = config()) => built(req, cfg).headers["x-opencode-session"];

test("OpenCode session is stable across tasks, proposers, repair turns and reconstructed configuration", () => {
  const initial = session();
  assert.match(initial, /^[a-f0-9]{64}$/);
  for (const proposer of ["episodeProposer", "relationshipProposer", "compactionProposer", "librarianProposer"]) {
    const req = request({ proposer, userPayload: { task: { taskId: "later-task" } },
      repairContext: { assistantOutput: "{}", userMessage: "Repair output" } });
    assert.equal(session(req, structuredClone(config())), initial);
  }
  assert.equal(session(request({ requestContext: { scope: { userId: "1", presetId: "private-preset" } } })), initial);
  for (const scope of [{ userId: 2, presetId: "private-preset" }, { userId: 1, presetId: "other-preset" }]) {
    assert.notEqual(session(request({ requestContext: { scope } })), initial);
  }
  assert.notEqual(session(request(), config({ apiKey: "other-key" })), initial);
  assert.throws(() => session(request({ requestContext: { scope: { userId: 1 } } })), /requestContext.scope/);
  const wire = built();
  assert.equal(wire.headers["User-Agent"], "BlogBackEnd-memory/1.0");
  assert.equal(JSON.stringify(wire).includes("private-preset"), false);
  assert.equal(JSON.stringify(wire).includes("test-key"), false);
  assert.equal(Object.hasOwn(wire.body, "requestContext"), false);
});

test("scope-free diagnostics share a run identity while persisted task IDs isolate fallback sessions", () => {
  const req = request({ requestContext: undefined });
  assert.equal(session(req), session(structuredClone(req)));
  assert.notEqual(session(req), session({ ...req, userPayload: { task: { taskId: "task-b" } } }));
  const diagnostic = { ...req, userPayload: {} };
  assert.equal(session(diagnostic), session({ ...diagnostic, proposer: "todoProposer" }));
  assert.notEqual(session(diagnostic), session(req));
});

test("OpenCode headers follow the declared profile, preserve aliases and do not leak to other gateways", () => {
  for (const profile of ["generic", "bai", "openrouter"]) {
    const cfg = config({ profile, ...(profile === "generic" ? { reasoningEffort: undefined } : {}) });
    assert.equal(built(request(), cfg).headers, undefined);
  }
  const proxy = built(request(), config({ baseUrl: "https://proxy.test/v1" }));
  assert.equal(proxy.headers["x-opencode-session"], session());
  const alias = built(request(), config({ adapter: "opencode-go-json-object", profile: undefined }));
  assert.deepEqual(alias, built());
  const deepseek = built(request(), config({ adapter: "deepseek-strict-tools", thinkingMode: "enabled" }));
  assert.equal(deepseek.headers, undefined);
  assert.throws(() => built(request(), config({ policy: { headerPolicy: "arbitrary-headers" } })), /headerPolicy/);
});

test("OpenCode model settings load from env and reject unsupported GLM effort and output modes", () => {
  const values = {
    CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-object",
    CHAT_MEMORY_V2_PROVIDER_PROFILE: "opencode-go",
    CHAT_MEMORY_V2_PROVIDER_BASE_URL: "https://opencode.ai/zen/go/v1",
    CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_MODEL: "glm-5.3-flash",
    CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: "low",
    CHAT_MEMORY_V2_PROVIDER_TIMEOUT_MS: "1000",
    CHAT_MEMORY_V2_PROVIDER_MAX_INPUT_TOKENS: "256000",
    CHAT_MEMORY_V2_PROVIDER_MAX_OUTPUT_TOKENS: "25600",
  };
  for (const effort of ["low", "high", "max"]) {
    const cfg = loadMemoryProviderConfig({ ...values, CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: effort });
    assert.equal(built(request(), cfg).body.reasoning_effort, effort);
  }
  for (const effort of ["none", "medium", "minimal", "xhigh", ""]) {
    assert.throws(() => loadMemoryProviderConfig({ ...values, CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT: effort }), /REASONING_EFFORT|mandatory/);
  }
  assert.throws(() => loadMemoryProviderConfig({ ...values,
    CHAT_MEMORY_V2_PROPOSER_MODELS_JSON: '{"episodeProposer":{"reasoningEffort":"medium"}}',
  }), /REASONING_EFFORT/);
  assert.throws(() => loadMemoryProviderConfig({ ...values, CHAT_MEMORY_V2_PROVIDER_ADAPTER: "openai-compatible-json-schema" }), /output mode json_schema/);
  assert.equal(built(request(), config({ model: "vendor/glm-5.3-flash", reasoningEffort: "medium" })).body.reasoning_effort, "medium");
});

test("transport uses preview headers on initial and repair calls, replacing stale case-insensitive headers", async () => {
  const cfg = config({ extraHeaders: { "X-OpenCode-Session": "stale", "user-agent": "generic-sdk", "X-Trace": "trace" } });
  let sent;
  const invoke = createStructuredTransport(cfg, { fetchImpl: async (url, options) => {
    sent = { url, ...options };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }) };
  } });
  for (const repairContext of [null, { assistantOutput: "{}", userMessage: "Repair" }]) {
    const req = request({ repairContext });
    const preview = built(req, cfg);
    assert.equal((await invoke(req)).rawSchemaValid, true);
    for (const [name, value] of Object.entries(preview.headers)) assert.equal(sent.headers[name], value);
    assert.equal(sent.headers.Authorization, "Bearer test-key");
    assert.equal(sent.headers["X-Trace"], "trace");
    assert.equal(Object.keys(sent.headers).filter(key => key.toLowerCase() === "x-opencode-session").length, 1);
    assert.deepEqual(JSON.parse(sent.body), preview.body);
  }
});

test("real adapter and GUI preview propagate identical scope for normal and profile specialist requests", async () => {
  const cfg = config();
  const sent = [];
  const invokeStructured = createStructuredTransport(cfg, { fetchImpl: async (_url, options) => {
    sent.push(options);
    const task = JSON.parse(JSON.parse(options.body).messages[1].content).task;
    const output = { sectionStatuses: Object.fromEntries(task.targetSections.map(section => [section, "noop"])), changes: [] };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] }) };
  } });
  const promptLoader = async () => "Return the required JSON";
  const adapter = createMemoryProviderAdapter({ invokeStructured, promptLoader });
  const sessionIds = [];
  for (const fixture of [envelope(), profileEnvelope()]) {
    sent.length = 0;
    const previews = await buildProviderRequestPreviews({ envelope: fixture, providerConfig: cfg, promptLoader });
    assert.equal((await adapter.propose(fixture)).status, "ok");
    assert.equal(sent.length, previews.length);
    for (let index = 0; index < previews.length; index++) {
      const preview = previews[index];
      for (const [key, value] of Object.entries(preview.headers)) assert.equal(sent[index].headers[key], value);
      assert.deepEqual(JSON.parse(sent[index].body), preview.body);
      assert.equal(Object.hasOwn(preview.headers, "Authorization"), false);
      sessionIds.push(preview.headers["x-opencode-session"]);
    }
  }
  assert.equal(new Set(sessionIds).size, 1);
});
