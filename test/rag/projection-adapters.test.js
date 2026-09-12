const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTurns, createChatRagProjectionAdapter } = require("../../modules/chat/rag/projectionAdapters");
const { createProjectionDrain } = require("../../modules/memory/application/projectionDrain");
const { createInitialMemoryState } = require("../../modules/memory/contracts");

test("RAG projection append includes a user message immediately before the checkpoint", () => {
  const messages = [
    { id: 10, session_id: 1, role: "user", content: "u1" },
    { id: 11, session_id: 1, role: "assistant", content: "a1" },
    { id: 12, session_id: 1, role: "user", content: "u2" },
    { id: 13, session_id: 1, role: "assistant", content: "a2" },
  ];
  const turns = buildTurns(messages, { afterMessageId: 12 });
  assert.deepEqual(turns.map((turn) => [turn.userMessage.id, turn.assistantMessage.id]), [[12, 13]]);
});

test("RAG projection pairs interleaved turns by persisted parent identity", () => {
  const messages = [
    { id: 20, session_id: 1, role: "user", turn_id: "turn-1", content: "u1" },
    { id: 21, session_id: 2, role: "user", turn_id: "turn-2", content: "u2" },
    { id: 22, session_id: 2, role: "assistant", turn_id: "turn-2", parent_user_message_id: 21, content: "a2" },
    { id: 23, session_id: 1, role: "assistant", turn_id: "turn-1", parent_user_message_id: 20, content: "a1" },
  ];
  const turns = buildTurns(messages);
  assert.deepEqual(turns.map((turn) => [turn.userMessage.id, turn.assistantMessage.id]), [[21, 22], [20, 23]]);
});

test("RAG resumes a failed rebuild after new turns arrive without losing its staged prefix", async () => {
  const messages = [];
  const addTurn = () => {
    const userId = messages.length + 1;
    messages.push({ id: userId, session_id: 1, role: "user", content: `u${userId}` });
    messages.push({ id: userId + 1, session_id: 1, role: "assistant", content: `a${userId}` });
  };
  addTurn(); addTurn();
  const staged = new Map();
  let chunks = [];
  let checkpoint = null;
  let embeddingCalls = 0;
  const client = { transaction: true };
  const adapter = createChatRagProjectionAdapter({
    database: { async query(_sql, params) { return { rows: messages.filter(m => m.id <= params[2]) }; } },
    config: { enabled: true, embeddingBatchSize: 1 },
    async createEmbeddings({ texts }) {
      if (++embeddingCalls === 2) throw new Error("embedding offline");
      return texts.map(() => [1, 0]);
    },
    chunker: {
      buildDocumentEmbeddingText: text => text,
      buildTurnChunks: ({ userContent, assistantContent }) => [{
        chunkIndex: 0, content: `${userContent}/${assistantContent}`, embeddingText: userContent, sourceHash: userContent,
      }],
    },
    repository: {
      async deleteAllChunks() { chunks = []; },
      async upsertChunk(chunk) { chunks.push(chunk); },
      async prepareProjectionStage(_u, _p, identity, options) {
        assert.equal(options.client, client);
        for (const chunk of staged.values()) Object.assign(chunk, identity);
      },
      async upsertProjectionStage(chunk, identity, options) {
        assert.equal(options.client, client);
        staged.set(chunk.lastMessageId, { ...chunk, ...identity });
      },
      async promoteProjectionStage(_u, _p, identity, options) {
        assert.equal(options.client, client);
        chunks = [...staged.values()].filter(chunk => chunk.boundaryMessageId === identity.boundaryMessageId);
        staged.clear();
      },
    },
  });
  const drain = createProjectionDrain({ projectionKey: "rag", adapter, repositories: {
    state: { async getState() { return createInitialMemoryState(); } },
    source: { async getBoundary() { return messages.length; } },
    sidecars: {
      async getProjectionCheckpoint() { return checkpoint; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpoint = value; },
    },
    async withTransaction(work) { return work(client); },
  } });
  await assert.rejects(drain.drain(1, "default"), /embedding offline/);
  assert.equal(checkpoint.processedBoundaryMessageId, 2);
  assert.deepEqual([...staged.keys()], [2]);
  addTurn();
  const resumed = await drain.drain(1, "default");
  assert.equal(resumed.status, "healthy");
  assert.equal(resumed.processedBoundaryMessageId, 6);
  assert.deepEqual(chunks.map(chunk => chunk.lastMessageId), [2, 4, 6]);
  assert.equal(embeddingCalls, 4, "the committed first batch does not need new embeddings");
});
