const test = require("node:test");
const assert = require("node:assert/strict");

let embed = async () => [[1, 0]];
let search = async () => [];
const fake = (request, exports) => {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

fake("../../config", {
  chatRagConfig: {
    enabled: true, queryTimeoutMs: 15, minQueryChars: 1, queryEmbeddingTemplate: "{{query}}",
    rerankerEnabled: false, topK: 3, mmrCandidateMultiplier: 2, minSimilarity: 0.2,
    contextBeforeMessages: 0, contextAfterMessages: 0, sceneRecallEnabled: false,
  },
  memoryV2Config: { enabled: true },
});
fake("../../logger", { logger: { warn() {}, error() {} } });
fake("../../services/llm/embeddings", { createEmbeddings: (options) => embed(options) });
fake("../../services/llm/reranker", { rerankDocuments: async () => [] });
fake("../../modules/chat/rag/sceneRecall", { generateSceneRecallForSource: async () => "" });
fake("../../modules/chat/rag/repo", {
  searchSimilarChunks: (options) => search(options),
  listMessagesAroundChunk: async () => [],
});
fake("../../modules/memory", { listSuppressionTombstones: async () => [] });

const { retrieveChatRagContext } = require("../../modules/chat/rag/retriever");

async function assertDegraded() {
  const result = await retrieveChatRagContext({ userId: 1, presetId: "p", query: "hello", beforeMessageId: 10 });
  assert.equal(result.stats.reason, "retrieval_degraded");
  assert.equal(result.stats.degraded, true);
  assert.deepEqual(result.messages, []);
}

test("embedding HTTP 429 degrades to empty RAG", async () => {
  embed = async () => { throw Object.assign(new Error("limited"), { status: 429 }); };
  await assertDegraded();
});

test("invalid embedding dimensions degrade to empty RAG", async () => {
  embed = async () => { throw new Error("Invalid embedding dimensions: expected 2, got 1"); };
  await assertDegraded();
});

test("RAG database errors degrade to empty RAG", async () => {
  embed = async () => [[1, 0]];
  search = async () => { throw Object.assign(new Error("db offline"), { code: "ECONNREFUSED" }); };
  await assertDegraded();
});

test("aggregate RAG deadline degrades without waiting for a stuck embedding call", async () => {
  search = async () => [];
  embed = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const started = performance.now();
  await assertDegraded();
  assert.equal(performance.now() - started < 100, true);
});

test("client abort is propagated instead of being reported as RAG degradation", async () => {
  const controller = new AbortController();
  embed = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const promise = retrieveChatRagContext({ userId: 1, presetId: "p", query: "hello", beforeMessageId: 10, signal: controller.signal });
  controller.abort(new Error("Client disconnected"));
  await assert.rejects(promise, /Client disconnected/);
});
