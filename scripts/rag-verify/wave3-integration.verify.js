"use strict";

const Module = require("module");
const assert = require("assert");

const CONFIG_PATH = require.resolve("../../config");
const DB_PATH = require.resolve("../../db");
const EMBEDDINGS_PATH = require.resolve("../../services/llm/embeddings");
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
  contextHeader: "[更早的共同记忆]\\nEarlier dialogue excerpts.",
  contextEntryTemplate: "{{recall}}",
  recallTemplate: "当时情景：\\n{{scene}}\\n\\n相关对话：\\n{{dialogue}}",
  recallIncludeAssistant: true,
  recallUserMaxChars: 140,
  recallAssistantMaxChars: 420,
  recallContentMaxChars: 160,
  topK: 3,
  minSimilarity: 0.5,
  minQueryChars: 1,
  maxContextChars: 1800,
  chunkMaxChars: 1200,
  chunkOverlapChars: 120,
  debugIncludeContent: false,
  mmrLambda: 0.7,
  mmrCandidateMultiplier: 2,
  contextBeforeMessages: 2,
  contextAfterMessages: 0,
  sceneRecallEnabled: false,
  sceneRecallContextTurns: 50,
  sceneRecallMaxOutputChars: 700,
  sceneRecallProviderId: "deepseek",
  sceneRecallModelId: "deepseek-v4-flash",
};

const rows = [
  {
    id: 1,
    first_message_id: 10,
    last_message_id: 11,
    chunk_index: 0,
    content: "User\ncluster alpha 1\nAssistant\nreply",
    embedding: "[1,0,0]",
    group: "cluster",
  },
  {
    id: 2,
    first_message_id: 12,
    last_message_id: 13,
    chunk_index: 0,
    content: "User\ncluster alpha 2\nAssistant\nreply",
    embedding: "[0.99,0.01,0]",
    group: "cluster",
  },
  {
    id: 3,
    first_message_id: 14,
    last_message_id: 15,
    chunk_index: 0,
    content: "User\ncluster alpha 3\nAssistant\nreply",
    embedding: "[0.98,0.02,0]",
    group: "cluster",
  },
  {
    id: 4,
    first_message_id: 16,
    last_message_id: 17,
    chunk_index: 0,
    content: "User\ndistinct beta\nAssistant\nreply",
    embedding: "[0,1,0]",
    group: "distinct",
  },
  {
    id: 5,
    first_message_id: 18,
    last_message_id: 19,
    chunk_index: 0,
    content: "User\ndistinct gamma\nAssistant\nreply",
    embedding: "[0,0,1]",
    group: "distinct",
  },
  {
    id: 6,
    first_message_id: 20,
    last_message_id: 21,
    chunk_index: 0,
    content: "User\ndistinct delta\nAssistant\nreply",
    embedding: "[0,0.7,0.7]",
    group: "distinct",
  },
];

async function stubDbQuery(sql, params) {
  const upper = String(sql || "").trim().toUpperCase();
  if (!upper.startsWith("SELECT")) return { rows: [] };

  if (upper.includes("FROM CHAT_MESSAGES")) {
    const messages = rows.flatMap((row) => [
      {
        id: row.first_message_id,
        user_id: 1,
        preset_id: "default",
        session_id: 99,
        role: "user",
        content: String(row.content).match(/^User\n([\s\S]*?)\nAssistant\n([\s\S]*)$/)?.[1] || "",
        created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
      {
        id: row.last_message_id,
        user_id: 1,
        preset_id: "default",
        session_id: 99,
        role: "assistant",
        content: String(row.content).match(/^User\n([\s\S]*?)\nAssistant\n([\s\S]*)$/)?.[2] || "",
        created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
    ]);
    if (upper.includes("ID < $4")) {
      return { rows: messages.filter((row) => row.id < params[3]).sort((a, b) => b.id - a.id).slice(0, params[4]) };
    }
    if (upper.includes("ID BETWEEN $4 AND $5")) {
      return { rows: messages.filter((row) => row.id >= params[3] && row.id <= params[4]).sort((a, b) => a.id - b.id) };
    }
    if (upper.includes("ID > $4")) {
      return { rows: messages.filter((row) => row.id > params[3]).sort((a, b) => a.id - b.id).slice(0, params[4]) };
    }
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
injectStub(LOGGER_PATH, { logger: { error() {}, warn() {}, info() {}, debug() {}, debugFull() {} } });

const { retrieveChatRagContext } = require("../../services/chat/rag/retriever");

(async () => {
  const result = await retrieveChatRagContext({
    userId: 1,
    presetId: "default",
    query: "remember the old shared context",
    beforeMessageId: 100,
  });

  assert.strictEqual(result.enabled, true, "RAG should be enabled");
  assert.strictEqual(result.stats.reason, "matches", "retrieval should match candidates");
  assert.deepStrictEqual(result.stats.mmr, { lambda: 0.7, candidateLimit: 6 }, "MMR stats should be reported");
  assert.ok(result.sources.length <= fakeChatRagConfig.topK, "final source count must not exceed topK");

  const clusterCount = result.sources.filter((source) => source.sourceKind === "cluster").length;
  const distinctCount = result.sources.filter((source) => source.sourceKind === "distinct").length;
  assert.ok(clusterCount <= 1, `MMR should keep at most one cluster member, got ${clusterCount}`);
  assert.ok(distinctCount >= 2, `MMR should select distinct memories, got ${distinctCount}`);

  const content = result.messages[0]?.content || "";
  assert.ok(content.includes("distinct beta") || content.includes("distinct gamma"), "rendered content should include a distinct memory");
  assert.ok(!content.includes("similarity="), "rendered content must not leak similarity metadata");
  assert.ok(!content.includes("message="), "rendered content must not leak message metadata");

  console.log("wave3-integration.verify OK: MMR de-duplicated cluster in retrieval");
})().catch((error) => {
  console.error("wave3-integration.verify ERROR:", error?.stack || error?.message || String(error));
  process.exit(1);
});
