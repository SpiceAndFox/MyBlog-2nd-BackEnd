const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

let baseUrl = "http://127.0.0.1/";
const config = {
  enabled: true,
  queryTimeoutMs: 40,
  minQueryChars: 1,
  queryEmbeddingTemplate: "{{query}}",
  embeddingProvider: "openai-compatible",
  embeddingBaseUrl: baseUrl,
  embeddingApiKey: "local-test",
  embeddingModel: "qwen-test-embedding",
  embeddingDimensions: 2,
  embeddingIncludeDimensionsParam: false,
  embeddingRawBody: {},
  embeddingTimeoutMs: 15,
  rerankerEnabled: false,
  topK: 3,
  mmrCandidateMultiplier: 2,
  minSimilarity: 0.2,
  sceneRecallEnabled: false,
};

require("../../config").configureApplicationConfig({ chatRagConfig: config });
const { createEmbeddings } = require("../../services/llm/embeddings");
const { createChatRagRetriever } = require("../../modules/chat/rag/retriever");
const retrieveChatRagContext = createChatRagRetriever({
  config,
  logger: { warn() {}, error() {} },
  createEmbeddings,
  rerankDocuments: async () => [],
  generateSceneRecallForSource: async () => "",
  repository: {
    searchSimilarChunks: async () => [],
    listMessagesAroundChunk: async () => [],
  },
}).retrieveChatRagContext;

let behavior = "429";
let server;

test.before(async () => {
  server = http.createServer((_req, res) => {
    if (behavior === "429") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    if (behavior === "wrong-dimensions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [1] }] }));
      return;
    }
    // Keep the response open long enough for the embedding and aggregate RAG
    // deadlines to exercise the real fetch abort path.
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    }, 200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.embeddingBaseUrl = `http://127.0.0.1:${server.address().port}/`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function retrieve() {
  return retrieveChatRagContext({ userId: 7, presetId: "companion", query: "hello", beforeMessageId: 20 });
}

test("real embedding HTTP 429 degrades the composed RAG query", async () => {
  behavior = "429";
  config.embeddingTimeoutMs = 200;
  config.queryTimeoutMs = 250;
  const result = await retrieve();
  assert.deepEqual(result.messages, []);
  assert.equal(result.stats.reason, "retrieval_degraded");
  assert.equal(result.stats.failure, "http_429");
});

test("real embedding response dimension corruption degrades the composed RAG query", async () => {
  behavior = "wrong-dimensions";
  config.embeddingTimeoutMs = 200;
  config.queryTimeoutMs = 250;
  const result = await retrieve();
  assert.deepEqual(result.messages, []);
  assert.equal(result.stats.reason, "retrieval_degraded");
  assert.equal(result.stats.degraded, true);
});

test("real embedding timeout aborts quickly and degrades without blocking main-chat latency", async () => {
  behavior = "timeout";
  config.embeddingTimeoutMs = 15;
  config.queryTimeoutMs = 40;
  const startedAt = performance.now();
  const result = await retrieve();
  const elapsed = performance.now() - startedAt;
  assert.deepEqual(result.messages, []);
  assert.equal(result.stats.reason, "retrieval_degraded");
  assert.equal(elapsed < 100, true, `RAG degradation took ${elapsed}ms`);
});
