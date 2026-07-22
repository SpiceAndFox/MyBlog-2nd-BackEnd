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
