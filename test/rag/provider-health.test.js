const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatRagModule } = require("../../modules/chat/rag");
const { createEmbeddingClient } = require("../../modules/chat/rag/infrastructure/embeddings");

const config = {
  enabled: true, queryTimeoutMs: 1000, minQueryChars: 1, queryEmbeddingTemplate: "{{query}}",
  embeddingProvider: "openai-compatible", embeddingBaseUrl: "https://example.test/v1/",
  embeddingApiKey: "test", embeddingModel: "test", embeddingDimensions: 2,
  embeddingTimeoutMs: 1000, rerankerEnabled: false, sceneRecallEnabled: false,
  topK: 3, mmrCandidateMultiplier: 2, minSimilarity: 0.2,
};

test("embedding health is observational: repeated failures never block later real requests", async () => {
  let calls = 0;
  const rag = createChatRagModule({ config: { rag: config, memory: {} }, database: { query: async () => ({ rows: [] }) },
    logger: { warn() {}, error() {}, info() {}, debug() {} }, llm: { complete: async () => "" }, infrastructure: {
      embeddingClient: { createEmbeddings: async () => {
        if (++calls <= 5) throw Object.assign(new Error("unavailable"), { status: 401 });
        return [[1, 0]];
      } },
      rerankerClient: { rerankDocuments: async () => [] },
    } });
  assert.equal(rag.getHealthSnapshot().embeddingProvider.status, "unknown");
  assert.equal(calls, 0);
  for (let i = 1; i <= 6; i++) {
    await rag.retrieve({ userId: 1, presetId: "default", query: "hello", beforeMessageId: 20 });
    assert.equal(calls, i);
    assert.equal(rag.getHealthSnapshot().embeddingProvider.status, i <= 5 ? "degraded" : "healthy");
  }
  assert.equal(rag.retryEmbeddingProvider, undefined);
});

test("embedding HTTP errors retain Retry-After for the task scheduler", async () => {
  for (const value of ["60", "Wed, 01 Jan 2031 00:00:00 GMT"]) {
    const start = Date.now();
    const client = createEmbeddingClient({ config, fetchImpl: async () => ({ ok: false, status: 429,
      headers: { get: () => value }, text: async () => '{"error":{"message":"rate limited"}}' }) });
    await assert.rejects(client.createEmbeddings({ texts: ["hello"] }), error => {
      assert.equal(error.status, 429);
      if (value === "60") assert.ok(Date.parse(error.retryAfterAt) >= start + 60_000);
      else assert.equal(error.retryAfterAt, "2031-01-01T00:00:00.000Z");
      return true;
    });
  }
});
