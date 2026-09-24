const test = require("node:test");
const assert = require("node:assert/strict");
const { createPromptDebugDecorator } = require("../../shared/observability/promptDebug");

function createPort(calls) {
  return {
    async complete(options) {
      calls.push({ method: "complete", options });
      return { content: "ok" };
    },
    async createStreamResponse(options) {
      calls.push({ method: "stream", options });
      return { body: "response" };
    },
    streamDeltas() {},
  };
}

test("prompt debug decorator is a no-op when disabled", () => {
  const debug = createPromptDebugDecorator({
    enabled: false,
    write() { throw new Error("must not be called"); },
  });
  const port = createPort([]);
  assert.equal(debug.decorate(port), port);
});

test("prompt debug decorator records complete and stream requests without changing behavior", async () => {
  const calls = [];
  const records = [];
  const port = createPort(calls);
  const debug = createPromptDebugDecorator({
    enabled: true,
    write(event, payload) { records.push({ event, payload }); },
  });
  const decorated = debug.decorate(port);

  const options = {
    providerId: "deepseek",
    model: "deepseek-flash",
    messages: [{ role: "user", content: "hello" }],
    settings: { systemPromptPresetId: "default", systemPrompt: "system" },
    requestContext: { userId: 7, sessionId: 11 },
    signal: new AbortController().signal,
  };

  assert.deepEqual(await decorated.complete(options), { content: "ok" });
  assert.deepEqual(await decorated.createStreamResponse(options), { body: "response" });
  assert.equal(decorated.streamDeltas, port.streamDeltas);
  assert.deepEqual(calls.map(({ method }) => method), ["complete", "stream"]);
  assert.deepEqual(records.map(({ event }) => event), ["chat_api_request", "chat_api_request"]);
  assert.deepEqual(records[0].payload, {
    stream: false,
    userId: 7,
    sessionId: 11,
    presetId: "default",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messages: [{ role: "user", content: "hello" }],
    settings: { systemPromptPresetId: "default", systemPrompt: "system" },
  });
  assert.equal(records[1].payload.stream, true);
});

test("prompt debug write failures never affect LLM calls", async () => {
  const debug = createPromptDebugDecorator({
    enabled: true,
    write() { throw new Error("disk full"); },
  });
  const decorated = debug.decorate(createPort([]));
  assert.deepEqual(
    await decorated.complete({ providerId: "p", model: "m", messages: [] }),
    { content: "ok" },
  );
});