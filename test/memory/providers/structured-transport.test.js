const test = require("node:test");
const assert = require("node:assert/strict");
const { parseToolArguments } = require("../../../modules/memory/infrastructure/providers/deepSeekStrictToolsTransport");
const { compileOpencodeGoSchema } = require("../../../modules/memory/infrastructure/providers/opencodeGoSchemaCompiler");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");

test("DeepSeek tool argument parser only repairs excess trailing closing braces", () => {
  assert.deepEqual(parseToolArguments('{"ok":true}}'), {
    output: { ok: true }, recovery: "trimmed_1_trailing_brace", error: null,
  });
  assert.deepEqual(parseToolArguments('{"ok":true}}}'), {
    output: { ok: true }, recovery: "trimmed_2_trailing_brace", error: null,
  });
  assert.equal(parseToolArguments('{"ok":').error, "tool_arguments_invalid_json");
  assert.equal(parseToolArguments('{"ok":tru}').error, "tool_arguments_invalid_json");
});

test("structured transport factory maps DeepSeek strict tool calls to normalized output", async () => {
  let request;
  const invoke = createStructuredTransport({
    adapter: "deepseek-strict-tools",
    baseUrl: "https://api.deepseek.com/beta",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    timeoutMs: 1000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: "deepseek-v4-flash",
          choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "probe", arguments: '{"ok":true}' } }] } }],
        }),
      };
    },
  });
  const result = await invoke({
    systemPrompt: "prompt",
    userPayload: { value: 1 },
    responseSchema: { name: "probe", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } },
  });
  assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
  assert.equal(request.body.response_format, undefined);
  assert.equal(request.body.max_tokens, 1024);
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.body.tools[0].function.strict, true);
  assert.equal(request.body.tool_choice.function.name, "probe");
  assert.deepEqual(result.output, { ok: true });
});

test("structured transport routes models by proposer and falls back to the default", async () => {
  const models = [];
  const invoke = createStructuredTransport({
    adapter: "deepseek-strict-tools",
    baseUrl: "https://api.deepseek.com/beta",
    apiKey: "test-key",
    model: "default-model",
    proposerModels: { currentStateProposer: "scene-model", profileRelationshipProposer: "profile-model" },
    timeoutMs: 1000,
    maxInputTokens: 1_000_000,
  }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      models.push(request.model);
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "probe", arguments: '{"ok":true}' } }] } }],
        }),
      };
    },
  });
  const request = {
    systemPrompt: "prompt",
    userPayload: {},
    responseSchema: { name: "probe", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
  };
  const scene = await invoke({ ...request, proposer: "currentStateProposer" });
  const profile = await invoke({ ...request, proposer: "profileRelationshipProposer" });
  const relationship = await invoke({ ...request, proposer: "relationshipProposer" });
  const todo = await invoke({ ...request, proposer: "todoProposer" });
  assert.deepEqual(models, ["scene-model", "profile-model", "profile-model", "default-model"]);
  assert.equal(scene.model, "scene-model");
  assert.equal(profile.model, "profile-model");
  assert.equal(relationship.model, "profile-model");
  assert.equal(todo.model, "default-model");
});

test("structured transport enforces input capability before dispatch", async () => {
  let called = false;
  const invoke = createStructuredTransport({
    adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "model",
    timeoutMs: 1000, maxInputTokens: 4, maxOutputTokens: 32,
  }, { fetchImpl: async () => { called = true; throw new Error("must not dispatch"); } });
  await assert.rejects(() => invoke({ systemPrompt: "long prompt", userPayload: {}, responseSchema: { name: "x", schema: {} } }), /exceeds configured context capability/);
  assert.equal(called, false);
});

test("OpenAI-compatible HTTP safety rejection is normalized", async () => {
  const invoke = createStructuredTransport({
    adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "model",
    timeoutMs: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 32,
  }, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: "content_filter", message: "blocked by safety policy" } }) }) });
  const response = await invoke({ systemPrompt: "prompt", userPayload: {}, responseSchema: { name: "x", schema: {} } });
  assert.equal(response.safetyBlocked, true);
});

test("DeepSeek strict adapter rejects the official non-beta endpoint", () => {
  assert.throws(() => createStructuredTransport({
    adapter: "deepseek-strict-tools", baseUrl: "https://api.deepseek.com", apiKey: "key", model: "deepseek-v4-flash", timeoutMs: 1000,
  }), /api\.deepseek\.com\/beta/);
});

test("OpenCode Go adapter strips uniqueItems, folds descriptions, and disables reasoning", async () => {
  let request;
  const invoke = createStructuredTransport({
    adapter: "opencode-go-json-schema",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "hy3",
    timeoutMs: 1000,
    maxInputTokens: 250_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: "hy3",
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
        }),
      };
    },
  });
  const result = await invoke({
    proposer: "todoProposer",
    systemPrompt: "prompt",
    userPayload: { value: 1 },
    responseSchema: {
      name: "probe",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: { ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer" } } },
      },
    },
  });
  assert.equal(request.url, "https://opencode.test/v1/chat/completions");
  assert.equal(request.body.reasoning_effort, "none");
  assert.equal(request.body.max_tokens, 1024);
  const jsonSchema = request.body.response_format.json_schema;
  assert.equal(jsonSchema.strict, true);
  assert.deepEqual(jsonSchema.schema.properties.ids, {
    type: "array",
    minItems: 1,
    description: "Array items must be unique.",
    items: { type: "integer" },
  });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.model, "hy3");
});

test("OpenCode Go schema compiler strips nested uniqueItems without touching supported keywords", () => {
  const compiled = compileOpencodeGoSchema({
    type: "object",
    properties: {
      changes: {
        oneOf: [
          { type: "object", properties: { refs: { type: "array", uniqueItems: true, minItems: 2, items: { type: "string", minLength: 1 } } } },
          { type: "object", properties: { tags: { type: "array", uniqueItems: false, items: { type: "string" } } } },
        ],
      },
    },
  });
  const [refsBranch, tagsBranch] = compiled.properties.changes.oneOf;
  assert.deepEqual(refsBranch.properties.refs, {
    type: "array",
    minItems: 2,
    description: "Array items must be unique.",
    items: { type: "string", minLength: 1 },
  });
  assert.deepEqual(tagsBranch.properties.tags, { type: "array", items: { type: "string" } });
});

test("OpenCode Go adapter routes model and reasoning effort by proposer with profile inheritance", async () => {
  const requests = [];
  const invoke = createStructuredTransport({
    adapter: "opencode-go-json-schema",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "hy3",
    reasoningEffort: "none",
    proposerModels: {
      profileRelationshipProposer: { model: "deepseek-v4-pro", reasoningEffort: "high" },
      todoProposer: { reasoningEffort: "low" },
    },
    timeoutMs: 1000,
    maxInputTokens: 250_000,
  }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push([request.model, request.reasoning_effort]);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }) };
    },
  });
  const request = { systemPrompt: "prompt", userPayload: {}, responseSchema: { name: "x", schema: {} } };
  await invoke({ ...request, proposer: "todoProposer" });
  await invoke({ ...request, proposer: "relationshipProposer" });
  await invoke({ ...request, proposer: "episodeProposer" });
  assert.deepEqual(requests, [["hy3", "low"], ["deepseek-v4-pro", "high"], ["hy3", "none"]]);
});
