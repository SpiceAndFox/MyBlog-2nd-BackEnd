const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { createChatLlmCatalog, createChatLlmRuntime, createProductionModelPolicy } = require("../../modules/chat");
const { createChatSettingsService } = require("../../modules/chat/application/settings");
const { createGetChatMetaUseCase } = require("../../modules/chat/application/meta");
const { loadApplicationConfig } = require("../../config");

const modelId = "gemini-4-argon";
const messages = [{ role: "system", content: "Be helpful." }, { role: "user", content: "Hello" }];

function harness(providerId, { timeoutMs = 60000, completionAdapters } = {}) {
  const environment = {
    ...dotenv.parse(fs.readFileSync(path.join(__dirname, "../../.env.example"))),
    NODE_ENV: "test", DATABASE_URL: "postgres://test:test@localhost/test", JWT_SECRET: "test-secret",
    GEMINI_API_KEY: "test-google", BOTCF_API_KEY: "test-botcf",
    GEMINI_BASE_URL: "https://gemini.test", BOTCF_BASE_URL: "https://botcf.test/v1",
    CHAT_DEFAULT_PROVIDER: providerId, GEMINI_DEFAULT_MODEL: modelId, BOTCF_DEFAULT_MODEL: modelId,
  };
  const catalog = createChatLlmCatalog({ environment });
  const config = loadApplicationConfig(environment, { chatLlmCatalog: catalog, loadMemoryConfig: () => ({ enabled: false }) });
  const settings = createChatSettingsService({
    config: config.chatConfig, presetRepository: { getPreset: async () => null },
    providers: catalog.providers, models: catalog.models, schema: catalog.settingsSchema, isModelAllowed: () => true,
  });
  const getMeta = createGetChatMetaUseCase({
    config: config.chatConfig, providers: catalog.providers, models: catalog.models, isModelAllowed: () => true,
  });
  const requests = [];
  class FakeGoogleGenAI {
    models = {
      generateContent: async request => { requests.push(request); return { text: "ok" }; },
      generateContentStream: async request => {
        requests.push(request);
        return (async function* () { yield { text: "ok" }; })();
      },
    };
  }
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs }, adapters: {
    completionAdapters, GoogleGenAIClass: FakeGoogleGenAI,
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    },
  } });
  return { catalog, config, settings, getMeta, runtime, requests };
}

for (const providerId of ["gemini", "botcf"]) {
  const effortKey = providerId === "gemini" ? "thinkingLevel" : "reasoningEffort";
  const efforts = providerId === "gemini" ? ["LOW", "MEDIUM", "HIGH"] : ["low", "medium", "high"];
  test(`${providerId} Argon metadata and settings use official defaults without changing explicit token limits`, async () => {
    const { catalog, config, settings, getMeta } = harness(providerId);
    const context = { providerId, modelId };
    assert.equal(config.chatConfig.defaultModelByProvider[providerId], modelId);
    assert.equal(settings.resolveProviderModel({}).modelId, modelId);
    const meta = await getMeta();
    const model = meta.providers.find(provider => provider.id === providerId).models.find(entry => entry.id === modelId);
    assert.deepEqual(model.defaults, { [effortKey]: efforts[1], maxOutputTokens: 65536 });
    assert.equal(meta.defaults[effortKey], efforts[1]);
    assert.equal(meta.defaults.maxOutputTokens, 65536);
    const controls = catalog.settingsSchema.getActiveSchemaControls(providerId, modelId);
    assert.equal(controls.filter(control => control.key === effortKey).length, 1);
    assert.equal(controls.filter(control => control.key === "maxOutputTokens").length, 1);
    for (const key of ["temperature", "topP", "thinkingBudget"]) {
      assert.equal(controls.some(control => control.key === key), false);
    }
    const normalized = settings.normalize(settings.sanitize({ ...context, temperature: 0.7, topP: 0.9, thinkingBudget: 1024 }), context);
    assert.equal(normalized[effortKey], efforts[1]);
    assert.equal(normalized.maxOutputTokens, 65536);
    for (const key of ["temperature", "topP", "thinkingBudget"]) assert.equal(Object.hasOwn(normalized, key), false);
    assert.equal(settings.normalize({ maxOutputTokens: 32768 }, context).maxOutputTokens, 32768);
    assert.equal(settings.normalize({ maxOutputTokens: 1048576 }, context).maxOutputTokens, 65536);
    for (const effort of efforts) assert.equal(settings.validate({ [effortKey]: effort }, context), null);
    for (const effort of ["MINIMAL", "minimal", "none", "invalid"]) {
      assert.match(settings.validate({ [effortKey]: effort }, context), /Invalid setting/);
    }
  });

  test(`${providerId} Argon remains subject to production model approval`, () => {
    const policy = chat => createProductionModelPolicy({ NODE_ENV: "production",
      CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({ chat, memory: ["existing-memory-model"] }),
    });
    assert.equal(policy({ [providerId]: ["gemini-3.1-pro-preview"] }).isChatModelAllowed(providerId, modelId), false);
    assert.equal(policy({ [providerId]: [modelId] }).isChatModelAllowed(providerId, modelId), true);
  });

  for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
    test(`${providerId} Argon ${method} filters incompatible parameters and preserves thinking controls`, async () => {
      const { settings, runtime, requests } = harness(providerId);
      for (const effort of [undefined, ...efforts]) {
        const normalized = settings.normalize(effort ? { [effortKey]: effort } : {}, { providerId, modelId });
        await runtime[method]({ providerId, model: modelId, messages,
          settings: { ...normalized, temperature: 0.7, topP: 0.9, thinkingBudget: 1024, enableWebSearch: true },
          rawConfig: { temperature: 1, topP: 0.9, topK: 40, candidateCount: 2, cachedContent: "caches/old",
            thinkingConfig: { thinkingLevel: "MINIMAL", thinkingBudget: 1024 }, maxOutputTokens: 1048576 },
          rawBody: { temperature: 1, top_p: 0.9, top_k: 40, reasoning_effort: "none", max_tokens: 1048576,
            thinkingConfig: { thinkingLevel: "MINIMAL" }, extra_body: { google: {} }, tools: [{ googleSearch: {} }] },
        });
        const sent = requests.at(-1);
        if (providerId === "gemini") {
          assert.equal(sent.model, modelId);
          assert.equal(sent.config.maxOutputTokens, 65536);
          assert.deepEqual(sent.config.thinkingConfig, { thinkingLevel: effort || "MEDIUM" });
          assert.equal(sent.config.httpOptions.timeout, 1200000);
          assert.equal(sent.config.systemInstruction, "Be helpful.");
          assert.deepEqual(sent.config.tools, [{ googleSearch: {} }]);
          for (const key of ["temperature", "topP", "topK", "candidateCount", "cachedContent"]) {
            assert.equal(Object.hasOwn(sent.config, key), false);
          }
        } else {
          assert.equal(sent.url, "https://botcf.test/v1/chat/completions");
          assert.equal(sent.headers.Authorization, "Bearer test-botcf");
          assert.deepEqual(sent.body, { model: modelId, messages,
            stream: method === "createChatCompletionStreamResponse", max_tokens: 65536, reasoning_effort: effort || "medium" });
        }
      }
      if (providerId === "botcf") {
        await runtime[method]({ providerId, model: modelId, messages });
        assert.equal(requests.at(-1).body.reasoning_effort, "medium");
        await assert.rejects(runtime[method]({ providerId, model: modelId, messages, settings: { reasoningEffort: "none" } }), /Invalid reasoningEffort/);
      }
    });
  }

  test(`${providerId} Argon timeout defaults preserve explicit worker timeouts and longer configured timeouts`, async () => {
    const received = [];
    const adapter = {
      createChatCompletion: async options => received.push(options),
      createChatCompletionStreamResponse: async options => received.push(options),
    };
    const completionAdapters = { googleGenAi: adapter, openAiCompatible: adapter };
    const { runtime } = harness(providerId, { completionAdapters });
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      await runtime[method]({ providerId, model: modelId });
      assert.equal(received.at(-1).timeoutMs, 1200000);
      await runtime[method]({ providerId, model: modelId, timeoutMs: 30000 });
      assert.equal(received.at(-1).timeoutMs, 30000);
      const longer = harness(providerId, { timeoutMs: 1800000, completionAdapters });
      await longer.runtime[method]({ providerId, model: modelId });
      assert.equal(received.at(-1).timeoutMs, 1800000);
    }
  });
}
