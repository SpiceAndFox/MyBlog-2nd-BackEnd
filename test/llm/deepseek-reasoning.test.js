const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatLlmCatalog, createChatLlmRuntime } = require("../../modules/chat");

test("DeepSeek accepts and preserves low/high/max in completion and streaming requests", async () => {
  const requests = [];
  const catalog = createChatLlmCatalog({ environment: {
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: "https://deepseek.test/v1",
  } });
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs: 1000 }, adapters: {
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  } });
  for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      for (const reasoningEffort of ["low", "high", "max"]) {
        const settings = { thinkingMode: "enabled", reasoningEffort };
        assert.ok(!catalog.settingsSchema.validateSettingsWithSchema(settings, { providerId: "deepseek", modelId: model }));
        await runtime[method]({ providerId: "deepseek", model, settings, messages: [{ role: "user", content: "hello" }] });
        assert.equal(requests.at(-1).model, model);
        assert.deepEqual(requests.at(-1).thinking, { type: "enabled" });
        assert.equal(requests.at(-1).reasoning_effort, reasoningEffort);
      }
      await runtime[method]({ providerId: "deepseek", model,
        settings: { thinkingMode: "disabled", reasoningEffort: "low" },
        messages: [{ role: "user", content: "hello" }],
      });
      assert.deepEqual(requests.at(-1).thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(requests.at(-1), "reasoning_effort"), false);
    }
    assert.match(catalog.settingsSchema.validateSettingsWithSchema({ reasoningEffort: "invalid" },
      { providerId: "deepseek", modelId: model }), /Invalid setting reasoningEffort/);
  }
});
