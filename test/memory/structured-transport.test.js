const test = require("node:test");
const assert = require("node:assert/strict");
const { parseToolArguments } = require("../../modules/memory/infrastructure/providers/deepSeekStrictToolsTransport");
const { createStructuredTransport } = require("../../modules/memory/infrastructure/providers/structuredTransportFactory");

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

