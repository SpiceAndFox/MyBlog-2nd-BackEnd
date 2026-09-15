const test = require("node:test");
const assert = require("node:assert/strict");

const { createChatGistService } = require("../../modules/chat/admin");
const { createChatGistRepository } = require("../../modules/chat/infrastructure/repositories/gistRepository");
const { loadGistRuntimeConfig } = require("../../config/gistRuntime");
const text = require("../../modules/chat/application/textUtils");
const { createGistFixture } = require("./support/gist-fixture");
const { gistTestEnvironment } = require("./support/gist-env");

function logger() {
  return { debug() {}, warn() {}, error() {} };
}

test("Gist Repository uses its injected database adapter", async () => {
  const calls = [];
  const repository = createChatGistRepository({
    database: {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        return { rows: [{ message_id: 3, user_id: 2, preset_id: "default", gist_text: "gist" }] };
      },
    },
  });

  const gist = await repository.getGist(2, "default", 3);

  assert.equal(gist.gistText, "gist");
  assert.deepEqual(calls[0].params, [2, "default", 3]);
});

test("Gist generation is an injected Chat application service and skips an unchanged result", async () => {
  const fixture = createGistFixture();
  fixture.addSource(12);
  let providerCalls = 0;
  const gistRepository = fixture.repository;
  const service = createChatGistService({
    config: {
      ...loadGistRuntimeConfig(gistTestEnvironment()),
      enabled: true,
      workerConcurrency: 1,
      workerProviderId: "deepseek",
      workerModelId: "gist-model",
      workerTimeoutMs: 1000,
      workerSettings: {},
      workerRaw: {},
      maxChars: 20,
    },
    contextConfig: { recentWindowAssistantGistEnabled: true },
    gistRepository,
    llm: { async complete() { providerCalls += 1; return { content: "- 温柔安抚。\n- 给出下一步！" }; } },
    text,
    logger: logger(),
  });

  await service.requestGeneration({
    userId: 7,
    presetId: "companion",
    messageId: 12,
    content: "assistant source",
    userContent: "user source",
  });
  await service.requestGeneration({
    userId: 7,
    presetId: "companion",
    messageId: 12,
    content: "assistant source",
    userContent: "user source",
  });

  assert.equal(providerCalls, 1);
  const stored = fixture.stored.get(12);
  assert.equal(stored.gistText, "温柔安抚；给出下一步；");
  assert.equal(stored.providerId, "deepseek");
  assert.equal(stored.modelId, "gist-model");
});

test("Gist backfill honors the configured per-request admission bound", () => {
  const scheduled = [];
  const repository = createGistFixture().repository;
  repository.enqueueGistTask = async scope => { scheduled.push(scope); return null; };
  const service = createChatGistService({
    config: { ...loadGistRuntimeConfig(gistTestEnvironment()),
      enabled: true, workerConcurrency: 2, workerTimeoutMs: 1000, maxChars: 20 },
    contextConfig: { recentWindowAssistantGistEnabled: true },
    gistRepository: repository,
    llm: { async complete() { return { content: "gist" }; } },
    text,
    logger: logger(),
  });
  const candidates = Array.from({ length: 15 }, (_, index) => ({ messageId: index + 1, content: `message-${index}` }));

  const result = service.scheduleBackfill({ userId: 1, presetId: "default", gistBackfillCandidates: candidates });

  assert.deepEqual(result, { scheduled: 3, maxPerRequest: 3, candidatesCount: 15 });
  assert.equal(scheduled.length, 3);
});
