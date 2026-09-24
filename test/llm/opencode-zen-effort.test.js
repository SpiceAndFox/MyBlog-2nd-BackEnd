const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatLlmCatalog, createChatLlmRuntime } = require("../../modules/chat");
const { createChatSettingsService } = require("../../modules/chat/application/settings");
const { createGetChatMetaUseCase } = require("../../modules/chat/application/meta");

const providerId = "opencode-zen-claude";
const modelId = "claude-opus-5-5";
const efforts = ["low", "medium", "high", "xhigh", "max"];

function harness() {
  const requests = [];
  const catalog = createChatLlmCatalog({ environment: {
    OPENCODE_ZEN_API_KEY: "test-key",
    OPENCODE_ZEN_MESSAGES_BASE_URL: "https://zen.test/v1",
    OPENCODE_GO_API_KEY: "test-key",
    OPENCODE_GO_BASE_URL: "https://go.test/v1",
  } });
  const config = { dayTimeZone: "Asia/Shanghai", defaultProviderId: providerId, defaultModelByProvider: { [providerId]: modelId } };
  const settings = createChatSettingsService({
    config, presetRepository: { getPreset: async () => null },
    providers: catalog.providers, models: catalog.models, schema: catalog.settingsSchema,
    isModelAllowed: () => true,
  });
  const getMeta = createGetChatMetaUseCase({ config, providers: catalog.providers, models: catalog.models, isModelAllowed: () => true });
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs: 1000 }, adapters: {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, body: (async function* () {})(), json: async () => ({
        content: [{ type: "thinking", thinking: "", signature: "test" }, { type: "text", text: "ok" }],
      }) };
    },
  } });
  return { catalog, settings, getMeta, runtime, requests };
}

test("Opus 5.5 publishes effort controls and preserves selected effort through chat settings", async () => {
  const { catalog, settings, getMeta } = harness();
  const meta = await getMeta();
  const provider = meta.providers.find(entry => entry.id === providerId);
  assert.equal(provider.capabilities.thinking, true);
  const control = provider.settingsSchema.find(entry => entry.key === "reasoningEffort");
  const model = provider.models.find(entry => entry.id === modelId);
  assert.deepEqual(catalog.settingsSchema.getControlOptions(control, { model }).map(option => option.value), efforts);
  assert.equal(control.modelBlocklist.includes(modelId), false);
  assert.equal(meta.defaults.reasoningEffort, "medium");
  assert.equal(settings.normalize({}, { providerId, modelId }).reasoningEffort, "medium");
  for (const reasoningEffort of efforts) {
    const sanitized = settings.sanitize({ providerId, modelId, reasoningEffort });
    assert.equal(settings.validate(sanitized, { providerId, modelId }), null);
    assert.equal(settings.normalize(sanitized, { providerId, modelId }).reasoningEffort, reasoningEffort);
  }
  for (const reasoningEffort of ["none", "minimal", "invalid"]) {
    assert.match(settings.validate({ reasoningEffort }, { providerId, modelId }), /Invalid setting reasoningEffort/);
  }
});

for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
  test(`Opus 5.5 ${method} sends Anthropic effort and rejects unsupported values before fetching`, async () => {
    const { runtime, requests } = harness();
    const request = (reasoningEffort) => ({
      providerId, model: modelId, messages: [{ role: "user", content: "Hi" }],
      settings: { reasoningEffort, temperature: 0.7, topP: 0.9, maxOutputTokens: 16000, thinkingMode: "disabled" },
    });
    for (const effort of [undefined, ...efforts]) {
      const result = await runtime[method](request(effort));
      if (method === "createChatCompletion") assert.equal(result.content, "ok");
      const sent = requests.at(-1);
      assert.equal(sent.url, "https://zen.test/v1/messages");
      assert.deepEqual(sent.body.output_config, { effort: effort || "medium" });
      assert.equal(sent.body.stream, method === "createChatCompletionStreamResponse");
      assert.equal(sent.body.max_tokens, 16000);
      for (const key of ["reasoning_effort", "temperature", "top_p", "thinking"]) {
        assert.equal(Object.hasOwn(sent.body, key), false);
      }
    }
    const count = requests.length;
    for (const effort of ["none", "minimal", "invalid"]) {
      await assert.rejects(runtime[method](request(effort)), /Invalid reasoningEffort/);
    }
    assert.equal(requests.length, count);
  });
}

test("effort stays hidden and is not sent for other Zen models or OpenCode Go Messages", async () => {
  const { catalog, settings, runtime, requests } = harness();
  for (const model of catalog.models.listModelsForProvider(providerId).filter(entry => entry.id !== modelId)) {
    const controls = catalog.settingsSchema.getActiveSchemaControls(providerId, model.id);
    assert.equal(controls.some(control => control.key === "reasoningEffort"), false);
    assert.equal(Object.hasOwn(settings.normalize({ reasoningEffort: "max" }, { providerId, modelId: model.id }), "reasoningEffort"), false);
  }
  for (const context of [{ providerId, model: "claude-sonnet-4-6" }, { providerId: "opencode-go-messages", model: "minimax-m3" }]) {
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      await runtime[method]({ ...context, messages: [{ role: "user", content: "Hi" }],
        settings: { reasoningEffort: "max", maxOutputTokens: 4096, temperature: 0.7 } });
      assert.equal(Object.hasOwn(requests.at(-1).body, "output_config"), false);
      assert.equal(requests.at(-1).body.temperature, 0.7);
    }
  }
});
