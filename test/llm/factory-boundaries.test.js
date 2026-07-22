const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createChatLlmCatalog,
  createChatLlmRuntime,
  createProductionModelPolicy,
} = require("../../modules/chat");

function environment(suffix) {
  return {
    NODE_ENV: "test",
    DEEPSEEK_API_KEY: `deepseek-${suffix}`,
    DEEPSEEK_BASE_URL: `https://${suffix}.deepseek.test/v1/`,
    OPENROUTER_API_KEY: `openrouter-${suffix}`,
    OPENROUTER_BASE_URL: `https://${suffix}.openrouter.test/api/v1/`,
    OPENROUTER_SITE_URL: `https://${suffix}.blog.test`,
    OPENROUTER_APP_NAME: `Blog ${suffix}`,
  };
}

test("Chat LLM catalogs keep Provider credentials and attribution instance-local", () => {
  const first = createChatLlmCatalog({ environment: environment("first") });
  const second = createChatLlmCatalog({ environment: environment("second") });

  assert.deepEqual(first.providers.getProviderConfig("deepseek"), {
    id: "deepseek",
    name: "DeepSeek",
    apiKey: "deepseek-first",
    baseUrl: "https://first.deepseek.test/v1/",
  });
  assert.equal(second.providers.getProviderConfig("deepseek").apiKey, "deepseek-second");
  assert.deepEqual(first.providers.getProviderDefinition("openrouter").openaiCompatible.headers(), {
    "HTTP-Referer": "https://first.blog.test",
    "X-OpenRouter-Title": "Blog first",
  });
  assert.deepEqual(second.providers.getProviderDefinition("openrouter").openaiCompatible.headers(), {
    "HTTP-Referer": "https://second.blog.test",
    "X-OpenRouter-Title": "Blog second",
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.models.isSupportedModel("deepseek", "deepseek-v4-flash"), true);
});

test("production model policies are bound instances rather than configured globals", () => {
  const first = createProductionModelPolicy({
    NODE_ENV: "production",
    CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({
      chat: { deepseek: ["deepseek-v4-flash"] },
      memory: ["memory-first"],
    }),
  });
  const second = createProductionModelPolicy({
    NODE_ENV: "production",
    CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({
      chat: { deepseek: ["deepseek-v4-pro"] },
      memory: ["memory-second"],
    }),
  });

  assert.equal(first.isChatModelAllowed("deepseek", "deepseek-v4-flash"), true);
  assert.equal(first.isChatModelAllowed("deepseek", "deepseek-v4-pro"), false);
  assert.equal(second.isChatModelAllowed("deepseek", "deepseek-v4-pro"), true);
  assert.equal(first.isMemoryModelAllowed("memory-first"), true);
  assert.equal(second.isMemoryModelAllowed("memory-first"), false);
});

test("Chat completion gateway dispatches through injected protocol adapters", async () => {
  const catalog = createChatLlmCatalog({ environment: environment("dispatch") });
  const adapter = (name) => ({
    async createChatCompletion() { return { content: name }; },
    async createChatCompletionStreamResponse() { return { name }; },
    async *streamChatCompletionDeltas() { yield name; },
  });
  const runtime = createChatLlmRuntime({
    catalog,
    config: { timeoutMs: 1000 },
    adapters: {
      completionAdapters: {
        openAiCompatible: adapter("openai"),
        googleGenAi: adapter("google"),
        anthropicMessages: adapter("anthropic"),
      },
    },
  });

  assert.deepEqual(await runtime.createChatCompletion({ providerId: "deepseek" }), { content: "openai" });
  assert.deepEqual(await runtime.createChatCompletion({ providerId: "gemini" }), { content: "google" });
  assert.deepEqual(await runtime.createChatCompletion({ providerId: "opencode-zen-claude" }), { content: "anthropic" });
});
