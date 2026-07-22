const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMemorySegment } = require("../../modules/chat/application/context/segments/memory");

test("v2 memory is emitted as one context segment", () => {
  const segment = buildMemorySegment({ memoryV2: { renderedText: "[长期核心记忆]\n(无)" } });
  assert.equal(segment.messages.length, 1);
  assert.equal(segment.messages[0].role, "system");
  assert.match(segment.messages[0].content, /Memory Control v2/);
});
