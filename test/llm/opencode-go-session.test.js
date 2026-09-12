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
  return { runtime, requests };
}

function request(overrides = {}) {
  return {
    providerId: "opencode-go-openai",
    model: "glm-5.3-flash",
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
      const options = request({ providerId, model: providerId.endsWith("messages") ? "minimax-m3" : "glm-5.3-flash" });
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
