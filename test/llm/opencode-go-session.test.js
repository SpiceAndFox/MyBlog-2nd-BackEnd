const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatLlmCatalog, createChatLlmRuntime } = require("../../modules/chat");

function harness(apiKey = "test-key") {
  const requests = [];
  const catalog = createChatLlmCatalog({ environment: {
    OPENCODE_GO_API_KEY: apiKey,
    OPENCODE_GO_BASE_URL: "https://proxy.test/v1",
    OPENCODE_ZEN_API_KEY: apiKey,
    OPENCODE_ZEN_MESSAGES_BASE_URL: "https://zen.test/v1",
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: "https://deepseek.test/v1",
    OPENROUTER_API_KEY: apiKey,
    OPENROUTER_BASE_URL: "https://openrouter.test/v1",
    OPENROUTER_SITE_URL: "https://blog.test",
    OPENROUTER_APP_NAME: "Blog",
  } });
  const runtime = createChatLlmRuntime({ catalog, config: { timeoutMs: 1000 }, adapters: {
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return {
        ok: true,
        body: (async function* () {})(),
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
  } });
  return { catalog, runtime, requests };
}

function request(overrides = {}) {
  return {
    providerId: "opencode-go-openai",
    model: "glm-5.3",
    messages: [{ role: "user", content: "hello" }],
    settings: { maxOutputTokens: 1024 },
    requestContext: { userId: 7, sessionId: 11 },
    ...overrides,
  };
}

test("OpenCode Go sends stable session and application headers over both protocols and stream modes", async () => {
  const { runtime, requests } = harness();
  for (const providerId of ["opencode-go-openai", "opencode-go-messages"]) {
    for (const stream of [false, true]) {
      const options = request({ providerId, model: providerId.endsWith("messages") ? "minimax-m3" : "glm-5.3" });
      if (stream) await runtime.createChatCompletionStreamResponse(options);
      else assert.equal((await runtime.createChatCompletion(options)).content, "ok");
      const sent = requests.at(-1);
      assert.equal(sent.url, `https://proxy.test/v1/${providerId.endsWith("messages") ? "messages" : "chat/completions"}`);
      assert.equal(sent.body.stream, stream);
      assert.equal(sent.headers["User-Agent"], "BlogBackEnd-chat/1.0");
      assert.match(sent.headers["x-opencode-session"], /^[a-f0-9]{64}$/);
      assert.equal(sent.headers["Content-Type"], "application/json");
      if (providerId.endsWith("messages")) {
        assert.equal(sent.headers["x-api-key"], "test-key");
        assert.equal(sent.headers["anthropic-version"], "2023-06-01");
      } else assert.equal(sent.headers.Authorization, "Bearer test-key");
      for (const key of ["requestContext", "userId", "sessionId"]) assert.equal(Object.hasOwn(sent.body, key), false);
    }
  }
  assert.equal(new Set(requests.map(sent => sent.headers["x-opencode-session"])).size, 1);
  const recreated = harness();
  await recreated.runtime.createChatCompletion(request({
    requestContext: { userId: "7", sessionId: "11" },
    messages: [{ role: "user", content: "another turn" }],
  }));
  assert.equal(recreated.requests[0].headers["x-opencode-session"], requests[0].headers["x-opencode-session"]);
});

test("OpenCode Go catalogs expose GLM-5.3 and Kimi K3 with only supported controls", () => {
  const { catalog } = harness();
  const providerId = "opencode-go-openai";
  assert.deepEqual(catalog.models.listModelsForProvider(providerId).map(model => model.id), [
    "glm-5.3", "kimi-k3", "glm-5.2", "deepseek-v4-pro", "deepseek-flash",
  ]);
  for (const modelId of ["glm-5.3", "kimi-k3"]) {
    const controls = catalog.settingsSchema.getActiveSchemaControls(providerId, modelId);
    const model = catalog.settingsSchema.getProviderModel(providerId, modelId);
    const effort = controls.find(control => control.key === "reasoningEffort");
    assert.deepEqual(catalog.settingsSchema.getControlOptions(effort, { model }).map(option => option.value), ["max", "high", "low"]);
    assert.equal(controls.some(control => control.key === "thinkingMode"), false);
    assert.equal(controls.some(control => control.key === "enableWebSearch"), false);
    assert.equal(controls.some(control => control.key === "temperature"), modelId === "glm-5.3");
    for (const reasoningEffort of ["none", "minimal", "medium", "xhigh"]) {
      assert.match(catalog.settingsSchema.validateSettingsWithSchema({ reasoningEffort }, { providerId, modelId }), /Invalid setting reasoningEffort/);
    }
  }
  for (const modelId of ["glm-5.1", "mimo-v2.5-pro", "mimo-v2.5"]) assert.equal(catalog.models.isSupportedModel(providerId, modelId), false);
  assert.equal(catalog.settingsSchema.getProviderSettingsSchema(providerId).some(control => ["webSearchForceSearch", "webSearchMaxKeyword"].includes(control.key)), false);
});

test("OpenCode Go new models enforce reasoning and sampling rules in both stream modes", async () => {
  const { runtime, requests } = harness();
  for (const model of ["glm-5.3", "kimi-k3"]) {
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      for (const reasoningEffort of [undefined, "low", "high", "max"]) {
        await runtime[method](request({ model, settings: {
          thinkingMode: "disabled", reasoningEffort, temperature: 0.5, topP: 0.8,
          maxOutputTokens: 8192, enableWebSearch: true,
        }, rawBody: { thinking: { type: "disabled" }, n: 3, presence_penalty: 1, frequency_penalty: 1 } }));
        const body = requests.at(-1).body;
        assert.equal(body.model, model);
        assert.equal(body.reasoning_effort, reasoningEffort || "max");
        for (const key of ["thinking", "tools", "presence_penalty", "frequency_penalty", "top_p"]) assert.equal(Object.hasOwn(body, key), false);
        if (model === "kimi-k3") {
          assert.equal(body.max_completion_tokens, 8192);
          for (const key of ["temperature", "n", "max_tokens"]) assert.equal(Object.hasOwn(body, key), false);
        } else {
          assert.equal(body.temperature, 0.5);
          assert.equal(body.max_tokens, 8192);
        }
      }
      await assert.rejects(runtime[method](request({ model, settings: { reasoningEffort: "medium" } })), /Invalid reasoningEffort/);
    }
  }
  await runtime.createChatCompletion(request({ model: "glm-5.3", settings: { topP: 0 } }));
  assert.equal(requests.at(-1).body.top_p, 0.01);
  await runtime.createChatCompletion(request({ model: "glm-5.2", settings: { thinkingMode: "disabled", temperature: 0.75, enableWebSearch: true } }));
  assert.deepEqual(requests.at(-1).body.thinking, { type: "disabled" });
  assert.equal(requests.at(-1).body.reasoning_effort, undefined);
  assert.equal(requests.at(-1).body.tools[0].web_search.search_engine, "search-prime");
});

test("OpenCode Go isolates users, conversations and credentials and rejects incomplete context", async () => {
  const { runtime, requests } = harness();
  for (const requestContext of [{ userId: 7, sessionId: 11 }, { userId: 8, sessionId: 11 }, { userId: 7, sessionId: 12 }]) {
    await runtime.createChatCompletion(request({ requestContext }));
  }
  const other = harness("other-key");
  await other.runtime.createChatCompletion(request());
  assert.equal(new Set([...requests, ...other.requests].map(sent => sent.headers["x-opencode-session"])).size, 4);
  await assert.rejects(runtime.createChatCompletion(request({ requestContext: { userId: 7 } })), /requires userId and sessionId/);
  assert.equal(requests.length, 3);
});

test("standalone calls receive separate session headers without changing other providers or OpenRouter attribution", async () => {
  const { runtime, requests } = harness();
  for (let index = 0; index < 2; index++) {
    await runtime.createChatCompletion(request({ requestContext: undefined }));
    assert.match(requests.at(-1).headers["x-opencode-session"], /^[a-f0-9]{64}$/);
  }
  assert.notEqual(requests[0].headers["x-opencode-session"], requests[1].headers["x-opencode-session"]);
  for (const providerId of ["deepseek", "openrouter", "opencode-zen-claude"]) {
    for (const method of ["createChatCompletion", "createChatCompletionStreamResponse"]) {
      await runtime[method](request({ providerId }));
      const { headers } = requests.at(-1);
      assert.equal(Object.hasOwn(headers, "x-opencode-session"), false);
      assert.equal(Object.hasOwn(headers, "User-Agent"), false);
      if (providerId === "openrouter") {
        assert.equal(headers["HTTP-Referer"], "https://blog.test");
        assert.equal(headers["X-OpenRouter-Title"], "Blog");
      }
    }
  }
});
