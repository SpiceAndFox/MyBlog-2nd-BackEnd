const test = require("node:test");
const assert = require("node:assert/strict");

const calls = [];
const database = {
  async query(text, params) {
    calls.push({ text, params });
    if (calls.length === 1) {
      return { rows: [{ id: 10, role: "user", content: "current", created_at: "2026-01-01" }] };
    }
    return {
      rows: [
        { id: 11, role: "assistant", content: "allowed", created_at: "2026-01-01" },
        { id: 51, role: "assistant", content: "future", created_at: "2026-01-01" },
      ],
    };
  },
};

function fake(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

fake("../../db", database);
fake("../../config", { chatRagConfig: {} });

const { listMessagesAroundChunk } = require("../../services/chat/rag/repo");

test("dialogue lookup forwards and enforces the effective retrieval cutoff", async () => {
  const messages = await listMessagesAroundChunk({
    userId: 1,
    presetId: "companion",
    sessionId: 2,
    firstMessageId: 10,
    lastMessageId: 10,
    beforeMessages: 0,
    afterMessages: 2,
    maxMessageId: 50,
  });

  assert.deepEqual(calls.map((call) => call.params), [
    [1, "companion", 2, 10, 10],
    [1, "companion", 2, 10, 50, 2],
  ]);
  assert.deepEqual(messages.map((message) => message.id), [10, 11]);
});
