const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { selectRecentWindow, buildGapBridgeCoverage } = require("../../../modules/memory/domain");
const contextScenario = require("../support/context-scenario");
const { assessContextCoverage } = require("../../../modules/memory/domain/contextCoverage");

const TARGETS = ["scene", "todos", "standingAgreements", "episodes", "profileRelationship", "worldFacts"];

test("recent window uses Unicode code points, complete messages, and a user boundary", () => {
  const under = selectRecentWindow([{ id: 1, role: "assistant", content: "😀" }, { id: 2, role: "user", content: "好" }], 2);
  assert.equal(under.needsMemory, false);
  assert.equal(under.candidateChars, 2);

  const over = selectRecentWindow([{ id: 1, role: "user", content: "1111" }, { id: 2, role: "assistant", content: "2222" }, { id: 3, role: "assistant", content: "3333" }, { id: 4, role: "user", content: "4444" }], 9);
  assert.equal(over.needsMemory, true);
  assert.deepEqual(over.messages.map((row) => row.id), [4]);
  assert.equal(over.droppedToUserBoundary, 1);

  const oversizedLatest = selectRecentWindow([{ id: 1, role: "user", content: "😀😀😀😀" }], 3);
  assert.equal(oversizedLatest.messages[0].content, "😀😀😀😀");
});

test("GapBridge deduplicates target overlap and never truncates a raw message", () => {
  const state = createInitialMemoryState();
  const result = buildGapBridgeCoverage({ messages: contextScenario.sourceMessages, state, recentWindowStartMessageId: contextScenario.expected.recentWindowStartMessageId, ...contextScenario.gapBridge });
  assert.deepEqual(result.messages.map((row) => row.id), contextScenario.expected.retainedGapMessageIds);
  assert.deepEqual(result.messages[0].targetKeys, TARGETS);
  assert.equal(result.messages[0].content, "第四条");
  assert.equal(result.diagnostics.length, 6);
  assert.equal(result.diagnostics[0].omittedUpperMessageId, contextScenario.expected.omittedUpperMessageId);
  assert.equal(result.stats.truncated, true);
});

test("GapBridge retains every message when the raw character budget is not exceeded", () => {
  const state = createInitialMemoryState();
  const messages = [1, 2, 3, 4, 5].map((id) => ({
    id,
    role: id % 2 ? "user" : "assistant",
    content: "x",
  }));
  const result = buildGapBridgeCoverage({
    messages,
    state,
    recentWindowStartMessageId: 5,
    maxRawChars: 100,
    retainedMessages: 2,
  });
  assert.deepEqual(result.messages.map((row) => row.id), [1, 2, 3, 4]);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.stats.truncated, false);
});

test("coverage detects the slowest target and holes inside the retained bridge with sparse message ids", () => {
  const state = createInitialMemoryState();
  state.meta.targetCursors = Object.fromEntries(TARGETS.map(key => [key, 50]));
  state.meta.targetCursors.todos = 10;
  const messages = [
    { id: 10, role: "user", content: "old" },
    { id: 20, role: "assistant", content: "x" },
    { id: 40, role: "user", content: "oversized message cannot fit" },
    { id: 50, role: "assistant", content: "y" },
    { id: 90, role: "user", content: "now" },
  ];
  const options = { messages, state, recentWindowStartMessageId: 90, maxRawChars: 2, retainedMessages: 3 };
  const bridge = buildGapBridgeCoverage(options);
  assert.deepEqual(bridge.messages.map(row => row.id), [20, 50]);
  const coverage = assessContextCoverage({ needsMemory: true, gapBridge: bridge });
  assert.deepEqual(coverage, { complete: false, gaps: [{ targetKey: "todos", targetCursor: 10, omittedCount: 1, throughMessageId: 40 }] });
  state.meta.targetCursors.todos = 40;
  assert.equal(assessContextCoverage({ needsMemory: true, gapBridge: buildGapBridgeCoverage(options) }).complete, true);
});
