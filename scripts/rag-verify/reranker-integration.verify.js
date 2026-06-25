"use strict";

const Module = require("module");
const assert = require("assert");

const CONFIG_PATH = require.resolve("../../config");
const DB_PATH = require.resolve("../../db");
const EMBEDDINGS_PATH = require.resolve("../../services/llm/embeddings");
const RERANKER_PATH = require.resolve("../../services/llm/reranker");
const LOGGER_PATH = require.resolve("../../logger");

const fakeChatRagConfig = {
  enabled: true,
  embeddingProvider: "openai-compatible",
  embeddingModel: "test-embedding",
  embeddingDimensions: 3,
  embeddingBaseUrl: "http://stub",
  embeddingApiKey: "stub",
  embeddingIncludeDimensionsParam: false,
  embeddingTimeoutMs: 1000,
  embeddingBatchSize: 1,
  embeddingRawBody: {},
  queryEmbeddingTemplate: "query: {{query}}",
  documentEmbeddingTemplate: "text: {{content}}",
  turnTemplate: "User\\n{{user}}\\nAssistant\\n{{assistant}}",
  contextHeader: "[Earlier memory]\\nExcerpts.",
  contextEntryTemplate: "{{recall}}",
  recallTemplate: "{{dialogue}}",
  recallIncludeAssistant: true,
  recallUserMaxChars: 140,
  recallAssistantMaxChars: 420,
  recallContentMaxChars: 160,
  topK: 2,
  minSimilarity: 0.5,
  minQueryChars: 1,
  maxContextChars: 1800,
  chunkMaxChars: 1200,
  chunkOverlapChars: 120,
  debugIncludeContent: false,
  mmrLambda: 1,
  mmrCandidateMultiplier: 2,
  contextBeforeMessages: 0,
  contextAfterMessages: 0,
  sceneRecallEnabled: false,
  sceneRecallContextTurns: 0,
  sceneRecallMaxOutputChars: 700,
  sceneRecallProviderId: "deepseek",
  sceneRecallModelId: "deepseek-v4-flash",
  rerankerEnabled: true,
  rerankerProvider: "openai-compatible",
  rerankerBaseUrl: "http://stub",
  rerankerApiKey: "stub",
  rerankerModel: "Qwen/Qwen3-Reranker-8B",
  rerankerTimeoutMs: 1000,
  rerankerCandidateMultiplier: 5,
  rerankerMaxDocuments: 30,
  rerankerMaxDocumentChars: 1000,
  rerankerMinScore: 0.5,
  rerankerRawBody: {},
};

const rows = [
  { id: 1, first_message_id: 10, last_message_id: 11, chunk_index: 0, content: "User\nalpha prime\nAssistant\nreply", embedding: "[1,0,0]", group: "alpha" },
  { id: 2, first_message_id: 12, last_message_id: 13, chunk_index: 0, content: "User\nalpha second\nAssistant\nreply", embedding: "[0.99,0.01,0]", group: "alpha" },
  { id: 3, first_message_id: 14, last_message_id: 15, chunk_index: 0, content: "User\nunrelated beta\nAssistant\nreply", embedding: "[0,1,0]", group: "other" },
  { id: 4, first_message_id: 16, last_message_id: 17, chunk_index: 0, content: "User\nunrelated gamma\nAssistant\nreply", embedding: "[0,0,1]", group: "other" },
];

async function stubDbQuery(sql, params) {
  const upper = String(sql || "").trim().toUpperCase();
  if (!upper.startsWith("SELECT")) return { rows: [] };

  if (upper.includes("FROM CHAT_MESSAGES")) {
    return { rows: [] };
  }

  const limit = Number(params[8]);
  const selected = rows
    .filter((row) => row.last_message_id <= params[2])
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      session_id: 99,
      first_message_id: row.first_message_id,
      last_message_id: row.last_message_id,
      chunk_index: row.chunk_index,
      source_kind: row.group,
      source_hash: `hash-${row.id}`,
      content: row.content,
      embedding: row.embedding,
      metadata: { group: row.group },
      created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      updated_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      similarity: 0.9,
    }));
  return { rows: selected };
}

async function stubCreateEmbeddings({ texts } = {}) {
  return (Array.isArray(texts) ? texts : []).map(() => [1, 0, 0]);
}

const rerankCalls = [];
async function stubRerankDocuments({ query, documents } = {}) {
  rerankCalls.push({ query, count: documents.length });
  return documents.map((document, index) => {
    const score = String(document).toLowerCase().includes("alpha") ? 0.9 : 0.1;
    return { index, relevanceScore: score };
  });
}

function injectStub(absolutePath, exportsValue) {
  const stub = new Module(absolutePath, module);
  stub.exports = exportsValue;
  stub.filename = absolutePath;
  stub.loaded = true;
  require.cache[absolutePath] = stub;
}

injectStub(CONFIG_PATH, { chatRagConfig: fakeChatRagConfig });
injectStub(DB_PATH, { query: stubDbQuery });
injectStub(EMBEDDINGS_PATH, { createEmbeddings: stubCreateEmbeddings });
injectStub(RERANKER_PATH, { rerankDocuments: stubRerankDocuments });
injectStub(LOGGER_PATH, { logger: { error() {}, warn() {}, info() {}, debug() {}, debugFull() {} } });

const { retrieveChatRagContext } = require("../../services/chat/rag/retriever");

(async () => {
  const result = await retrieveChatRagContext({
    userId: 1,
    presetId: "default",
    query: "alpha",
    beforeMessageId: 100,
  });

  assert.strictEqual(result.enabled, true, "RAG should be enabled");
  assert.strictEqual(result.stats.reason, "matches", "retrieval should match candidates");
  assert.strictEqual(rerankCalls.length, 1, "reranker should be called once");
  assert.strictEqual(rerankCalls[0].count, rows.length, "reranker should score all vector candidates");

  assert.ok(result.stats.reranker, "reranker stats must be reported");
  assert.strictEqual(result.stats.reranker.enabled, true);
  assert.strictEqual(result.stats.reranker.used, true);
  assert.strictEqual(result.stats.reranker.fallback, false);

  assert.ok(result.sources.length <= fakeChatRagConfig.topK, "source count must not exceed topK");
  assert.ok(result.sources.length >= 1, "at least one alpha source should survive");
  for (const source of result.sources) {
    assert.ok(source.relevanceScore !== undefined, "source must carry a relevance score");
    assert.ok(source.relevanceScore >= fakeChatRagConfig.rerankerMinScore, "source must pass rerank min score");
    assert.strictEqual(source.sourceKind, "alpha", "only alpha sources should survive rerank filtering");
  }

  console.log("reranker-integration.verify OK: reranker reorders and filters retrieval candidates");
})().catch((error) => {
  console.error("reranker-integration.verify ERROR:", error?.stack || error?.message || String(error));
  process.exit(1);
});
