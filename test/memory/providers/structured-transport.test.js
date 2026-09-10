const test = require("node:test");
const assert = require("node:assert/strict");
const { parseToolArguments } = require("../../../modules/memory/infrastructure/providers/deepSeekStrictToolsTransport");
const { compileOpencodeGoSchema } = require("../../../modules/memory/infrastructure/providers/opencodeGoSchemaCompiler");
const { validateLocalJsonSchema } = require("../../../modules/memory/infrastructure/providers/localJsonSchemaValidator");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { buildStructuredMessages } = require("../../../modules/memory/infrastructure/providers/structuredHttpRequest");
const { parseJsonObjectContent } = require("../../../modules/memory/infrastructure/providers/structuredJsonContent");

test("DeepSeek thinking stays enabled for initial and repair requests with per-proposer effort", () => {
  const { buildDeepSeekHttpRequest } = require("../../../modules/memory/infrastructure/providers/structuredHttpRequest");
  const config = { baseUrl: "https://api.deepseek.com/beta", model: "deepseek-v4-flash", thinkingMode: "enabled", reasoningEffort: "low", proposerModels: { librarianProposer: { reasoningEffort: "high" } } };
  const request = { proposer: "librarianProposer", systemPrompt: "Return the tool result", userPayload: {}, responseSchema: { name: "result", schema: { type: "object", properties: {}, additionalProperties: false, required: [] } } };
  for (const repairContext of [undefined, { assistantOutput: '{"invalid":true}', userMessage: "Repair the rejected output" }]) {
    const { body } = buildDeepSeekHttpRequest(config, { ...request, repairContext });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.messages.some(message => message.role === "assistant"), false);
    if (repairContext) assert.match(JSON.stringify(body.messages), /invalid/);
  }
});

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

test("structured repair requests use provider-neutral multi-turn conversation roles", () => {
  assert.deepEqual(buildStructuredMessages({
    systemPrompt: "prompt",
    userPayload: { value: 1 },
    repairContext: {
      assistantOutput: '{"bad":true}',
      userMessage: "replace it",
    },
  }), [
    { role: "system", content: "prompt" },
    { role: "user", content: "{\"value\":1}" },
    { role: "assistant", content: "{\"bad\":true}" },
    { role: "user", content: "replace it" },
  ]);
});

test("incomplete repair candidates stay quoted in user diagnostic data", () => {
  const messages = buildStructuredMessages({
    systemPrompt: "prompt",
    userPayload: { value: 1 },
    repairContext: {
      userMessage: [
        "discard the broken serialization and replace it",
        "<rejected_output>",
        '"{\\"ids\\":[1]"',
        "</rejected_output>",
      ].join("\n"),
    },
  });

  assert.deepEqual(messages.map(({ role }) => role), ["system", "user", "user"]);
  assert.equal(messages.some(({ role }) => role === "assistant"), false);
  assert.match(messages[2].content, /<rejected_output>/);
  assert.match(messages[2].content, /\\"ids\\"/);
});

test("structured transport factory maps DeepSeek strict tool calls to normalized output", async () => {
  let request;
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "deepseek-strict-tools", reasoningEffort: "low",
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
  assert.deepEqual(request.body.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(request.body.tools[0].function.strict, true);
  assert.equal(request.body.tool_choice.function.name, "probe");
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.rawOutput, '{"ok":true}');
});

test("structured transport routes models by proposer and falls back to the default", async () => {
  const models = [];
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "deepseek-strict-tools", reasoningEffort: "low",
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
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "model",
    timeoutMs: 1000, maxInputTokens: 4, maxOutputTokens: 32,
  }, { fetchImpl: async () => { called = true; throw new Error("must not dispatch"); } });
  await assert.rejects(() => invoke({ systemPrompt: "long prompt", userPayload: {}, responseSchema: { name: "x", schema: {} } }), /exceeds configured context capability/);
  assert.equal(called, false);
});

test("OpenAI-compatible HTTP safety rejection is normalized", async () => {
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "model",
    timeoutMs: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 32,
  }, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: "content_filter", message: "blocked by safety policy" } }) }) });
  const response = await invoke({ systemPrompt: "prompt", userPayload: {}, responseSchema: { name: "x", schema: {} } });
  assert.equal(response.safetyBlocked, true);
});

test("OpenAI-compatible transport distinguishes aborted incomplete JSON from ordinary invalid JSON", async () => {
  const responses = [
    {
      choices: [{
        finish_reason: "abort",
        message: {
          content: '{"sectionStatuses":{"relationship":"changes"},"changes":[{"section":"relationship","action":"',
        },
      }],
    },
    {
      choices: [{
        finish_reason: "stop",
        message: { content: '{"ok":tru}' },
      }],
    },
  ];
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "opencode-go-json-schema",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "key",
    model: "model",
    timeoutMs: 1000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => responses.shift(),
    }),
  });
  const request = {
    systemPrompt: "prompt",
    userPayload: {},
    responseSchema: { name: "x", schema: {} },
  };

  const incomplete = await invoke(request);
  assert.equal(incomplete.output, null);
  assert.equal(incomplete.finishReason, "abort");
  assert.equal(incomplete.transportError, "content_incomplete_json");

  const invalid = await invoke(request);
  assert.equal(invalid.output, null);
  assert.equal(invalid.finishReason, "stop");
  assert.equal(invalid.transportError, "content_invalid_json");
});

test("DeepSeek transport classifies aborted incomplete tool arguments", async () => {
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "deepseek-strict-tools", reasoningEffort: "low",
    baseUrl: "https://api.deepseek.com/beta",
    apiKey: "key",
    model: "model",
    timeoutMs: 1000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: "abort",
          message: {
            tool_calls: [{
              function: {
                name: "x",
                arguments: '{"sectionStatuses":{"relationship":"changes"},"changes":[',
              },
            }],
          },
        }],
      }),
    }),
  });

  const result = await invoke({
    systemPrompt: "prompt",
    userPayload: {},
    responseSchema: { name: "x", schema: {} },
  });
  assert.equal(result.output, null);
  assert.equal(result.transportError, "tool_arguments_incomplete_json");
});

test("DeepSeek strict adapter rejects the official non-beta endpoint", () => {
  assert.throws(() => createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "deepseek-strict-tools", reasoningEffort: "low", baseUrl: "https://api.deepseek.com", apiKey: "key", model: "deepseek-v4-flash", timeoutMs: 1000,
  }), /api\.deepseek\.com\/beta/);
});

test("OpenCode Go adapter strips uniqueItems, folds descriptions, and disables reasoning", async () => {
  let request;
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
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
  assert.equal(result.rawOutput, '{"ok":true}');
  assert.equal(result.model, "hy3");
});

test("OpenCode Go JSON object adapter puts the bound schema in the prompt and parses JSON locally", async () => {
  const requests = [];
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "opencode-go-json-object",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "mimo-v2.5-pro",
    reasoningEffort: "low",
    timeoutMs: 1000,
    maxInputTokens: 250_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          model: "mimo-v2.5-pro",
          choices: [{ finish_reason: "stop", message: { content: '{"ids":[1]}\n\n{"ids"' } }],
        }),
      };
    },
  });
  const responseSchema = {
    name: "probe",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", enum: [1, 2] },
        },
      },
    },
  };
  const result = await invoke({
    proposer: "relationshipProposer",
    systemPrompt: "base prompt",
    userPayload: { value: 1 },
    responseSchema,
    repairContext: {
      assistantOutput: '{"ids":[]}',
      userMessage: "The prior JSON violated minItems; return a corrected replacement.",
    },
  });

  assert.equal(requests[0].url, "https://opencode.test/v1/chat/completions");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(requests[0].body, "reasoning_effort"), false);
  assert.equal(requests[0].body.max_tokens, 1024);
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[0].body.response_format, "json_schema"), false);
  assert.match(requests[0].body.messages[0].content, /^base prompt/);
  assert.match(requests[0].body.messages[0].content, /\[JSON_OBJECT_CONTRACT\]/);
  assert.match(requests[0].body.messages[0].content, /只返回一个完整 JSON 对象/);
  assert.match(requests[0].body.messages[0].content, /"uniqueItems":true/);
  assert.match(requests[0].body.messages[0].content, /"enum":\[1,2\]/);
  assert.deepEqual(requests[0].body.messages.map(({ role }) => role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), { value: 1 });
  assert.equal(requests[0].body.messages[2].content, '{"ids":[]}');
  assert.match(requests[0].body.messages[3].content, /violated minItems/);
  assert.deepEqual(result.output, { ids: [1] });
  assert.equal(result.rawOutput, '{"ids":[1]}\n\n{"ids"');
  assert.equal(result.transportRecovery, "accepted_schema_valid_json_prefix");
  assert.equal(result.transportError, null);
  assert.equal(result.finishReason, "stop");
});

test("OpenCode Go JSON object parser accepts a schema-valid object before an incomplete duplicate", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ids"],
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "integer" } },
    },
  };
  const validateCandidate = (candidate) => validateLocalJsonSchema(schema, candidate);

  for (const content of [
    '{"ids":[1]}\n\n{"ids"',
    '{"ids":[1]}\n\n{"',
    '{"ids":[1]}\n\n```json',
  ]) {
    const result = parseJsonObjectContent(content, {
      finishReason: "abort",
      validateCandidate,
    });
    assert.deepEqual(result.output, { ids: [1] });
    assert.equal(result.transportError, null);
    assert.equal(result.transportRecovery, "accepted_schema_valid_json_prefix");
    assert.equal(result.schemaValidation.ok, true);
  }
});

test("OpenCode Go JSON object parser never hides ambiguous or schema-invalid output", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ids"],
    properties: {
      ids: { type: "array", minItems: 1, items: { type: "integer" } },
    },
  };
  const validateCandidate = (candidate) => validateLocalJsonSchema(schema, candidate);

  for (const content of [
    '{"ids":[1]}\n\n{"ids":[2]}',
    '{"ids":[1]}\n\nunexpected prose',
    '{"ids":[]}\n\n{"ids"',
  ]) {
    const result = parseJsonObjectContent(content, {
      finishReason: "stop",
      validateCandidate,
    });
    assert.equal(result.output, null);
    assert.equal(result.transportError, "content_invalid_json");
    assert.equal(result.transportRecovery, null);
  }
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
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
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

test("OpenCode Go inference controls follow the effective proposer model", async () => {
  const requests = [];
  const invoke = createStructuredTransport({ maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "none",
    adapter: "opencode-go-json-object",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "hy3",
    reasoningEffort: "low",
    thinkingMode: "enabled",
    proposerModels: {
      episodeProposer: "mimo-v2.5-pro",
    },
    timeoutMs: 1000,
    maxInputTokens: 250_000,
  }, {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        }),
      };
    },
  });
  const request = {
    systemPrompt: "prompt",
    userPayload: {},
    responseSchema: { name: "x", schema: {} },
  };
  await invoke({ ...request, proposer: "todoProposer" });
  await invoke({ ...request, proposer: "episodeProposer" });

  assert.equal(requests[0].model, "hy3");
  assert.equal(requests[0].reasoning_effort, "low");
  assert.equal(Object.hasOwn(requests[0], "thinking"), false);
  assert.equal(requests[1].model, "mimo-v2.5-pro");
  assert.deepEqual(requests[1].thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(requests[1], "reasoning_effort"), false);
});
