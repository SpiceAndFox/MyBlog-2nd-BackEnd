const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatLlmCatalog, createChatLlmRuntime } = require("../../modules/chat");
const { createChatSettingsService } = require("../../modules/chat/application/settings");

function harness() {
  const requests = [];
  const catalog = createChatLlmCatalog({ environment: {
    GEMINI_API_KEY: "test-key",
    GEMINI_BASE_URL: "https://gemini.test",
  } });
  class FakeGoogleGenAI {
    models = {
      generateContent: async (request) => { requests.push(request); return { text: "ok" }; },
      generateContentStream: async (request) => { requests.push(request); return (async function* () { yield { text: "ok" }; })(); },
    };
  }
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs: 1000 }, adapters: { GoogleGenAIClass: FakeGoogleGenAI } });
  const settings = createChatSettingsService({
    config: { dayTimeZone: "Asia/Shanghai" },
    presetRepository: { getPreset: async () => null },
    providers: catalog.providers,
    models: catalog.models,
    schema: catalog.settingsSchema,
    isModelAllowed: () => true,
  });
  return { catalog, runtime, requests, settings };
}

for (const modelId of ["gemini-3.8-flash", "gemini-3.7-flash"]) {
  test(`${modelId} exposes supported settings and normalizes old Flash settings`, () => {
    const { catalog, settings } = harness();
    const context = { providerId: "gemini", modelId };
    assert.equal(settings.resolveProviderModel(context).modelId, modelId);
    const controls = catalog.settingsSchema.getActiveSchemaControls("gemini", modelId);
    assert.equal(controls.filter(control => control.key === "thinkingLevel").length, 1);
    for (const key of ["temperature", "topP", "thinkingBudget"]) {
      assert.equal(controls.some(control => control.key === key), false);
    }
    assert.match(settings.validate({ thinkingLevel: "MINIMAL" }, context), /Allowed values: LOW, MEDIUM, HIGH/);
    for (const thinkingLevel of ["LOW", "MEDIUM", "HIGH"]) {
      assert.equal(settings.validate({ thinkingLevel }, context), null);
    }
    const normalized = settings.normalize(settings.sanitize({ ...context, temperature: 0.7, topP: 0.9, thinkingBudget: -1, maxOutputTokens: 70000 }), context);
    assert.equal(normalized.thinkingLevel, "MEDIUM");
    assert.equal(normalized.maxOutputTokens, 65536);
    for (const key of ["temperature", "topP", "thinkingBudget"]) assert.equal(Object.hasOwn(normalized, key), false);
    assert.equal(catalog.models.listModelsForProvider("gemini").find(model => model.id === modelId).defaults.thinkingLevel, "MEDIUM");
  });

  test(`${modelId} filters incompatible parameters in streaming and non-streaming requests`, async () => {
    const { runtime, requests } = harness();
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      for (const thinkingLevel of ["LOW", "MEDIUM", "HIGH", "MINIMAL"]) {
        await runtime[method]({
          providerId: "gemini", model: modelId,
          messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "Hello" }],
          settings: { temperature: 0.7, topP: 0.9, maxOutputTokens: 65536, thinkingLevel, thinkingBudget: 1024, enableWebSearch: true },
          rawConfig: { topK: 40, candidateCount: 2, temperature: 1, thinkingConfig: { thinkingLevel: "MINIMAL" } },
        });
        const sent = requests.at(-1);
        assert.equal(sent.model, modelId);
        assert.equal(sent.config.maxOutputTokens, 65536);
        assert.equal(sent.config.systemInstruction, "Be kind.");
        assert.deepEqual(sent.config.tools, [{ googleSearch: {} }]);
        for (const key of ["temperature", "topP", "topK", "candidateCount"]) assert.equal(Object.hasOwn(sent.config, key), false);
        assert.deepEqual(sent.config.thinkingConfig, thinkingLevel === "MINIMAL" ? undefined : { thinkingLevel });
      }
    }
  });
}

test("retained Gemini preview models keep their settings and removed models are unavailable", async () => {
  const { catalog, settings, runtime, requests } = harness();
  assert.deepEqual(catalog.models.listModelsForProvider("gemini").map(model => model.id), [
    "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3-flash-preview", "gemini-3.1-pro-preview",
  ]);
  for (const modelId of ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"]) {
    assert.equal(settings.resolveProviderModel({ providerId: "gemini", modelId }).status, 400);
  }
  const normalized = settings.normalize({ maxOutputTokens: 65536 }, { providerId: "gemini", modelId: "gemini-3-flash-preview" });
  assert.equal(normalized.maxOutputTokens, 24000);
  assert.equal(normalized.thinkingLevel, "MINIMAL");
  await runtime.createChatCompletion({ providerId: "gemini", model: "gemini-3-flash-preview", messages: [{ role: "user", content: "Hi" }], settings: { ...normalized, temperature: 0.7, topP: 0.9, thinkingBudget: -1 } });
  assert.equal(requests[0].config.temperature, 0.7);
  assert.equal(requests[0].config.topP, 0.9);
  assert.deepEqual(requests[0].config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  assert.equal(settings.normalize({}, { providerId: "gemini", modelId: "gemini-3.1-pro-preview" }).thinkingLevel, "HIGH");
});
