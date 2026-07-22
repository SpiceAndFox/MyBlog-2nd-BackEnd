const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatContextCompiler } = require("../../modules/chat/application/contextCompiler");

function baseAdapters(overrides = {}) {
  return {
    memoryEnabled: false,
    memory: { async assembleContext() { throw new Error("Memory is disabled"); } },
    rag: { async retrieve() { return null; } },
    recentWindow: {
      async build() {
        return {
          recent: {
            messages: [{ id: 10, role: "user", content: "current" }],
            stats: { windowStartMessageId: 10, selected: 1, droppedToUserBoundary: 0 },
          },
          recentCandidates: [{ id: 10, role: "user", content: "current", created_at: "2026-07-22T00:00:00Z" }],
          selectedBeforeUserBoundary: 1,
          needsMemory: false,
          gistBackfillCandidates: [],
        };
      },
    },
    segments: { build: (state) => [{ role: "user", content: state.recent.messages.at(-1).content }] },
    timeContext: { build: () => ({ nowMs: 1, lastMs: null, gapMs: null }) },
    gist: { scheduleBackfill: () => ({ scheduled: 0 }) },
    randomUUID: () => "context-request-id",
    ...overrides,
  };
}

test("legacy context compilation uses injected recent-window and RAG ports with the pre-window boundary", async () => {
  const calls = [];
  const compile = createChatContextCompiler(baseAdapters({
    rag: {
      async retrieve(input) {
        calls.push(input);
        return { enabled: true, messages: [], sources: [{ messageId: 3 }], stats: { reason: "retrieved" } };
      },
    },
  }));

  const result = await compile({ userId: 7, presetId: "companion", systemPrompt: "system", upToMessageId: 10 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "current");
  assert.equal(calls[0].beforeMessageId, 9);
  assert.deepEqual(result.rag.sources, [{ messageId: 3 }]);
  assert.equal(result.memory, null);
});

test("Memory context compilation fails closed to projection rebuilding without querying stale RAG", async () => {
  let retrievals = 0;
  let segmentState = null;
  const notification = { id: 19, reason: "recovered" };
  const compile = createChatContextCompiler(baseAdapters({
    memoryEnabled: true,
    memory: {
      async assembleContext(input) {
        assert.equal(input.requestId, "context-request-id");
        return {
          schemaVersion: "2.0.1",
          sourceGeneration: 4,
          memorySegment: "durable memory",
          recent: { messages: [{ id: 20, role: "user", content: "now" }], stats: { windowStartMessageId: 20 } },
          timeCandidates: [],
          gapBridge: { messages: [], stats: { selected: 0 } },
          projectionCoverage: [{ projectionKey: "rag", queryHealth: "rebuilding", processedBoundary: 5 }],
          needsMemory: false,
          health: { status: "degraded" },
          notifications: [notification],
          debug: { generation: 4 },
        };
      },
    },
    rag: { async retrieve() { retrievals += 1; } },
    segments: {
      build(state) {
        segmentState = state;
        return [{ role: "user", content: "now" }];
      },
    },
  }));

  const result = await compile({ userId: 7, presetId: "companion", upToMessageId: 20 });

  assert.equal(retrievals, 0);
  assert.equal(segmentState.memoryV2.renderedText, "durable memory");
  assert.equal(result.rag.stats.reason, "projection_rebuilding");
  assert.deepEqual(result.memoryRecoveryNotifications, [notification]);
  assert.deepEqual(result.memoryHealth, { status: "degraded" });
});
