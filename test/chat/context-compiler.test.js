const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatContextCompiler } = require("../../modules/chat/application/contextCompiler");

function baseAdapters(overrides = {}) {
  return {
    memoryEnabled: false,
    memory: { async assembleContext() { throw new Error("Memory is disabled"); } },
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

test("Memory context compilation preserves memory, history and health without a retrieval port", async () => {
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
          needsMemory: false,
          health: { status: "degraded" },
          notifications: [notification],
          debug: { generation: 4 },
        };
      },
    },
    segments: {
      build(state) {
        segmentState = state;
        return [{ role: "user", content: "now" }];
      },
    },
  }));

  const result = await compile({ userId: 7, presetId: "companion", upToMessageId: 20 });

  assert.equal(segmentState.memoryV2.renderedText, "durable memory");
  assert.equal(Object.hasOwn(segmentState, "ragContext"), false);
  assert.equal(Object.hasOwn(result, "rag"), false);
  assert.deepEqual(result.memoryRecoveryNotifications, [notification]);
  assert.deepEqual(result.memoryHealth, { status: "degraded" });
});

test("recent-window compilation works without retrieval configuration and retains Gist backfill", async () => {
  let backfills = 0;
  const compile = createChatContextCompiler(baseAdapters({ gist: { scheduleBackfill() { backfills++; } } }));
  const result = await compile({ userId: 7, presetId: "companion", systemPrompt: "system", upToMessageId: 10 });
  assert.deepEqual(result.messages, [{ role: "user", content: "current" }]);
  assert.equal(result.memory, null);
  assert.equal(backfills, 1);
  assert.equal(Object.hasOwn(result, "rag"), false);
});
