const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contentHash,
  filterRagChunks,
  filterSuppressedMessages,
} = require("../../services/chat/rag/suppression");

test("RAG suppression requires provenance in v2 and conservatively rejects legacy chunks after a tombstone", () => {
  const legacy = { id: 1, metadata: {} };
  assert.deepEqual(filterRagChunks([legacy], [], { requireSourceRefs: false }), [legacy]);
  assert.deepEqual(filterRagChunks([legacy], [], { requireSourceRefs: true }), []);
  assert.deepEqual(filterRagChunks([legacy], [{ messageId: 10, contentHash: "sha256:x" }]), []);
});

test("RAG and Scene Recall raw windows apply the same messageId plus contentHash tombstone gate", () => {
  const messages = [
    { id: 10, content: "旧事实" },
    { id: 11, content: "修正事实" },
  ];
  const tombstones = [{ messageId: 10, contentHash: contentHash("旧事实") }];
  assert.deepEqual(filterSuppressedMessages(messages, tombstones).map((row) => row.id), [11]);

  const chunks = [
    { id: 1, metadata: { sourceRefs: [{ messageId: 10, contentHash: contentHash("旧事实") }] } },
    { id: 2, metadata: { sourceRefs: [{ messageId: 11, contentHash: contentHash("修正事实") }] } },
  ];
  assert.deepEqual(filterRagChunks(chunks, tombstones, { requireSourceRefs: true }).map((row) => row.id), [2]);
});
