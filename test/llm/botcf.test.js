const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { createChatLlmCatalog, createChatLlmRuntime, createProductionModelPolicy } = require("../../modules/chat");
const { createChatSettingsService } = require("../../modules/chat/application/settings");
const { createGetChatMetaUseCase } = require("../../modules/chat/application/meta");
const { loadApplicationConfig } = require("../../config");

const providerId = "botcf";
const modelId = "gemini-3.1-pro-preview";

function harness({ overrides = {}, respond, isModelAllowed = () => true } = {}) {
  const environment = {
    ...dotenv.parse(fs.readFileSync(path.join(__dirname, "../../.env.example"))),
    NODE_ENV: "test", DATABASE_URL: "postgres://test:test@localhost/test", JWT_SECRET: "test-secret",
    BOTCF_API_KEY: "botcf-test-key", CHAT_DEFAULT_PROVIDER: providerId,
    ...overrides,
  };
  const catalog = createChatLlmCatalog({ environment });
  const memoryConfig = { enabled: false };
  const config = loadApplicationConfig(environment, { chatLlmCatalog: catalog, loadMemoryConfig: () => memoryConfig });
  const settings = createChatSettingsService({
    config: config.chatConfig, presetRepository: { getPreset: async () => null },
    providers: catalog.providers, models: catalog.models, schema: catalog.settingsSchema, isModelAllowed,
  });
  const getMeta = createGetChatMetaUseCase({
    config: config.chatConfig, providers: catalog.providers, models: catalog.models, isModelAllowed,
  });
  const requests = [];
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs: 1000 }, adapters: {
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return respond ? respond(requests.at(-1)) : Response.json({ choices: [{ message: { content: "我在听。" } }] });
    },
  } });
  return { catalog, config, memoryConfig, settings, getMeta, runtime, requests };
}

test("BotCF appears in chat metadata with independent credentials and editable supported settings", async () => {
  const { catalog, settings, getMeta, config, memoryConfig } = harness();
  const meta = await getMeta();
  const provider = meta.providers.find(entry => entry.id === providerId);
  assert.equal(provider.adapter, "openai-compatible");
  assert.deepEqual(provider.models.map(model => model.id), [modelId]);
  assert.equal(meta.defaults.providerId, providerId);
  assert.equal(meta.defaults.modelId, modelId);
  assert.equal(meta.defaults.reasoningEffort, "low");
  assert.equal(meta.defaults.temperature, 1);
  assert.equal(meta.defaults.maxOutputTokens, 4096);
  assert.equal(meta.defaults.stream, true);
  assert.equal(provider.capabilities.webSearch, false);
  assert.equal(provider.capabilities.tools, false);
  assert.equal(catalog.providers.getProviderConfig(providerId).apiKey, "botcf-test-key");
  assert.equal(catalog.providers.getProviderDefinition("gemini").adapter, "google-genai");
  assert.equal(settings.resolveProviderModel({}).modelId, modelId);
  assert.equal(settings.resolveProviderModel({ providerId, modelId: `/v1beta/models/${modelId}:generateContent` }).status, 400);

  for (const reasoningEffort of ["low", "medium", "high"]) {
    const selected = settings.sanitize({ providerId, modelId, reasoningEffort, maxOutputTokens: 4096,
      thinkingLevel: "HIGH", thinkingMode: "disabled", presencePenalty: 1, enableWebSearch: true });
    assert.equal(settings.validate(selected, { providerId, modelId }), null);
    assert.equal(settings.normalize(selected, { providerId, modelId }).reasoningEffort, reasoningEffort);
    for (const key of ["thinkingLevel", "thinkingMode"]) {
      assert.equal(Object.hasOwn(selected, key), false);
    }
    for (const key of ["presencePenalty", "enableWebSearch"]) {
      assert.equal(provider.settingsSchema.some(control => control.key === key), false);
    }
  }
  for (const reasoningEffort of ["none", "minimal", "invalid"]) {
    assert.match(settings.validate({ reasoningEffort }, { providerId, modelId }), /Invalid setting reasoningEffort/);
  }
  assert.equal(config.memoryV2Config, memoryConfig);
  assert.equal(config.chatGistConfig.workerProviderId, "deepseek");
});

test("BotCF configuration is optional for existing deployments and respects explicit overrides", async () => {
  const { catalog, config } = harness({ overrides: {
    BOTCF_API_KEY: "", BOTCF_BASE_URL: undefined, BOTCF_DEFAULT_MODEL: undefined,
    BOTCF_DEFAULT_TEMPERATURE: undefined, BOTCF_DEFAULT_TOP_P: undefined,
    BOTCF_DEFAULT_MAX_OUTPUT_TOKENS: undefined, BOTCF_DEFAULT_STREAM: undefined,
    BOTCF_DEFAULT_ENABLE_WEB_SEARCH: undefined, CHAT_DEFAULT_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "deepseek-test-key", GEMINI_API_KEY: "google-only-key",
  } });
  assert.equal(config.chatConfig.defaultProviderId, "deepseek");
  assert.equal(config.chatConfig.defaultModelByProvider.botcf, modelId);
  assert.equal(catalog.providers.isProviderConfigured(providerId), false);
  assert.throws(() => catalog.providers.getProviderConfig(providerId), /Missing API key/);

  const custom = harness({ overrides: { BOTCF_DEFAULT_TEMPERATURE: "1.2", BOTCF_DEFAULT_MAX_OUTPUT_TOKENS: "8192" } });
  const meta = await custom.getMeta();
  assert.equal(meta.defaults.temperature, 1.2);
  assert.equal(meta.defaults.maxOutputTokens, 8192);
  assert.throws(() => harness({ overrides: { BOTCF_DEFAULT_MODEL: "unknown-model" } }), /BOTCF_DEFAULT_MODEL/);
});

for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
  test(`BotCF ${method} uses the chat endpoint, Bearer auth, and only its own wire parameters`, async () => {
    const { runtime, requests } = harness({ overrides: { BOTCF_BASE_URL: "https://botcf.test/v1/" } });
    const messages = [
      { role: "system", content: "认真倾听，保持既定人设。" },
      { role: "user", content: "今天很累。" },
      { role: "assistant", content: "发生什么了？" },
      { role: "user", content: "想和你聊聊。" },
    ];
    for (const reasoningEffort of [undefined, "low", "medium", "high"]) {
      const result = await runtime[method]({ providerId, model: modelId, messages,
        settings: { reasoningEffort, temperature: 1, topP: 0.95, maxOutputTokens: 4096,
          presencePenalty: 1, frequencyPenalty: 1, enableWebSearch: true, thinkingLevel: "HIGH" },
        rawBody: { model: "other", messages: [], stream: false, reasoning_effort: "none",
          thinking: { type: "disabled" }, thinkingConfig: { thinkingLevel: "HIGH" },
          extra_body: { google: {} }, tools: [{ googleSearch: {} }], group: "gemini-vertex",
          safetySettings: [], response_format: { type: "json_object" }, presence_penalty: 1 },
      });
      const sent = requests.at(-1);
      assert.equal(sent.url, "https://botcf.test/v1/chat/completions");
      assert.equal(sent.headers.Authorization, "Bearer botcf-test-key");
      assert.deepEqual(sent.body, {
        model: modelId, messages, stream: method === "createChatCompletionStreamResponse",
        temperature: 1, top_p: 0.95, max_tokens: 4096, reasoning_effort: reasoningEffort || "low",
      });
      if (method === "createChatCompletion") assert.equal(result.content, "我在听。");
    }
    const count = requests.length;
    for (const reasoningEffort of ["none", "minimal", "invalid"]) {
      await assert.rejects(runtime[method]({ providerId, model: modelId, messages, settings: { reasoningEffort } }), /Invalid reasoningEffort/);
    }
    await assert.rejects(runtime[method]({ providerId, model: "unknown", messages }), /Unsupported BotCF model/);
    assert.equal(requests.length, count);
  });
}

test("BotCF streaming preserves fragmented Chinese text and excludes reasoning and usage chunks", async () => {
  const wire = [
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    { choices: [{ delta: { reasoning_content: "internal reasoning" } }] },
    { choices: [{ delta: { content: "我在" } }] },
    { choices: [{ delta: { content: "听。" }, finish_reason: "stop" }] },
    { choices: [], usage: { total_tokens: 12 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const bytes = Buffer.from(wire);
  const { runtime, requests } = harness({ respond: () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.subarray(i, i + 2));
      controller.close();
    },
  })) });
  const controller = new AbortController();
  const response = await runtime.createChatCompletionStreamResponse({
    providerId, model: modelId, messages: [{ role: "user", content: "你好" }], signal: controller.signal,
  });
  let content = "";
  for await (const delta of runtime.streamChatCompletionDeltas({ providerId, response })) content += delta;
  assert.equal(content, "我在听。");
  assert.equal(requests[0].signal, controller.signal);
  controller.abort();
  assert.equal(requests[0].signal.aborted, true);
});

test("BotCF surfaces upstream authentication and throttling failures in both completion modes", async () => {
  for (const status of [401, 429]) {
    const { runtime } = harness({ respond: () => Response.json({ error: { message: "upstream rejected" } }, {
      status, headers: { "retry-after": "2" },
    }) });
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      await assert.rejects(runtime[method]({ providerId, model: modelId, messages: [{ role: "user", content: "Hi" }] }), error => {
        assert.equal(error.status, status);
        assert.equal(error.message, "upstream rejected");
        assert.ok(Number.isFinite(Date.parse(error.retryAfterAt)));
        return true;
      });
    }
  }
});

test("BotCF remains subject to the existing production chat model allowlist", async () => {
  const policy = chat => createProductionModelPolicy({ NODE_ENV: "production",
    CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({ chat, memory: ["existing-memory-model"] }),
  });
  const denied = policy({ deepseek: ["deepseek-flash"] });
  const hidden = harness({ isModelAllowed: denied.isChatModelAllowed });
  assert.equal((await hidden.getMeta()).providers.some(provider => provider.id === providerId), false);
  const allowed = policy({ botcf: [modelId] });
  const visible = harness({ isModelAllowed: allowed.isChatModelAllowed });
  assert.equal((await visible.getMeta()).defaults.providerId, providerId);
  assert.equal(visible.settings.resolveProviderModel({ providerId, modelId }).modelId, modelId);
  assert.equal(allowed.isMemoryModelAllowed("existing-memory-model"), true);
  assert.equal(allowed.isMemoryModelAllowed(modelId), false);
});
