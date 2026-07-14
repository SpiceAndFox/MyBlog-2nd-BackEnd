const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTurns } = require("../../services/chat/rag/projectionAdapters");

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
