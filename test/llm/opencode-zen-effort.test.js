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

test("effort stays hidden and is not sent for models without declared effort support", async () => {
  const { catalog, settings, runtime, requests } = harness();
  for (const model of catalog.models.listModelsForProvider(providerId).filter(entry => !entry.reasoningEfforts?.length)) {
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

test("Opus 4.6 exposes four efforts and removes sampling controls from normalized settings", async () => {
  const { catalog, settings, getMeta } = harness();
  const modelId = "claude-opus-4-6";
  const context = { providerId, modelId };
  const provider = (await getMeta()).providers.find(entry => entry.id === providerId);
  const model = provider.models.find(entry => entry.id === modelId);
  const control = provider.settingsSchema.find(entry => entry.key === "reasoningEffort");
  assert.deepEqual(catalog.settingsSchema.getControlOptions(control, { model }).map(option => option.value),
    ["low", "medium", "high", "max"]);
  assert.equal(control.modelBlocklist.includes(modelId), false);
  assert.equal(model.defaults.reasoningEffort, "medium");
  const controls = catalog.settingsSchema.getActiveSchemaControls(providerId, modelId);
  for (const key of ["temperature", "topP"]) {
    assert.equal(controls.some(control => control.key === key), false);
  }
  for (const reasoningEffort of ["low", "medium", "high", "max"]) {
    const sanitized = settings.sanitize({ ...context, reasoningEffort, temperature: 0.7, topP: 0.9 });
    assert.equal(settings.validate(sanitized, context), null);
    const normalized = settings.normalize(sanitized, context);
    assert.equal(normalized.reasoningEffort, reasoningEffort);
    assert.equal(Object.hasOwn(normalized, "temperature"), false);
    assert.equal(Object.hasOwn(normalized, "topP"), false);
  }
  assert.equal(settings.normalize({}, context).reasoningEffort, "medium");
  for (const reasoningEffort of ["none", "minimal", "xhigh", "invalid"]) {
    assert.match(settings.validate({ reasoningEffort }, context), /Invalid setting reasoningEffort/);
  }
});

for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
  test(`Opus 4.6 ${method} enables adaptive thinking and sends supported effort without sampling`, async () => {
    const { runtime, requests } = harness();
    const request = (reasoningEffort) => ({
      providerId, model: "claude-opus-4-6", messages: [{ role: "user", content: "Hi" }],
      temperature: 0.4, topP: 0.8,
      settings: { reasoningEffort, temperature: 0.7, topP: 0.9, maxOutputTokens: 16000 },
    });
    for (const effort of [undefined, "low", "medium", "high", "max"]) {
      const result = await runtime[method](request(effort));
      if (method === "createChatCompletion") assert.equal(result.content, "ok");
      const { url, body } = requests.at(-1);
      assert.equal(url, "https://zen.test/v1/messages");
      assert.deepEqual(body.thinking, { type: "adaptive" });
      assert.deepEqual(body.output_config, { effort: effort || "medium" });
      assert.equal(body.stream, method === "createChatCompletionStreamResponse");
      assert.equal(body.max_tokens, 16000);
      for (const key of ["reasoning_effort", "temperature", "top_p"]) assert.equal(Object.hasOwn(body, key), false);
    }
    const count = requests.length;
    for (const effort of ["none", "minimal", "xhigh", "invalid"]) {
      await assert.rejects(runtime[method](request(effort)), /Invalid reasoningEffort/);
    }
    assert.equal(requests.length, count);
  });

  test(`Messages ${method} never combines top-level temperature and topP`, async () => {
    const { runtime, requests } = harness();
    for (const context of [{ providerId, model: "claude-sonnet-4-5" }, { providerId: "opencode-go-messages", model: "minimax-m3" }]) {
      const request = { ...context, messages: [{ role: "user", content: "Hi" }], maxTokens: 4096 };
      await runtime[method]({ ...request, temperature: 0.7, topP: 0.9 });
      assert.equal(requests.at(-1).body.temperature, 0.7);
      assert.equal(Object.hasOwn(requests.at(-1).body, "top_p"), false);
      await runtime[method]({ ...request, topP: 0.9 });
      assert.equal(requests.at(-1).body.top_p, 0.9);
      assert.equal(Object.hasOwn(requests.at(-1).body, "temperature"), false);
    }
  });
}
