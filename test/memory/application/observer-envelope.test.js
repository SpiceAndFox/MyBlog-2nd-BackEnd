const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createObserver, canScheduleNormal } = require("../../../modules/memory/application/observer");
const { buildNormalEnvelope, normalDedupeKey } = require("../../../modules/memory/application/envelope");

const config = {
  targets: Object.fromEntries(["scene", "todos", "standingAgreements", "episodes", "profileRelationship", "worldFacts"].map((key) => [key, { lagThreshold: key === "scene" ? 2 : 3, contextWindow: 6 }])),
  overdueTodos: { maxRenderedItems: 2 },
};

test("Observer only emits lag-eligible and schedulable target intents", async () => {
  const state = createInitialMemoryState();
  const lags = [2, 3, 3];
  let currentTarget = 0;
  const observer = createObserver({
    config,
    stateRepository: { getState: async () => state },
    runtimeRepository: { getTargetStatuses: async () => [
      { target_key: "scene", status: "healthy" },
      { target_key: "todos", status: "healthy" },
      { target_key: "episodes", status: "halted" },
      { target_key: "standingAgreements", status: "halted" },
      { target_key: "profileRelationship", status: "capacity_blocked" },
      { target_key: "worldFacts", status: "retry_wait", next_retry_at: "2026-01-01T00:00:00Z" },
    ] },
    sourceRepository: { countAfter: async () => lags[currentTarget++] },
    now: () => new Date("2026-07-12T00:00:00Z"),
  });
  const eligible = await observer.observe(1, "default");
  assert.deepEqual(eligible.eligibleTasks.map((entry) => entry.targetKey), ["scene", "todos", "worldFacts"]);
});

test("retry_wait is schedulable only after nextRetryAt", () => {
  const now = new Date("2026-07-12T00:00:00Z");
  assert.equal(canScheduleNormal({ status: "retry_wait", nextRetryAt: "2026-07-11T00:00:00Z" }, now), true);
  assert.equal(canScheduleNormal({ status: "retry_wait", nextRetryAt: "2026-07-13T00:00:00Z" }, now), false);
  assert.equal(canScheduleNormal({ status: "halted" }, now), false);
  assert.equal(canScheduleNormal(null, now), false);
});

test("2.01 envelope exposes readable refs while keeping ids, hashes and provenance private", () => {
  const state = createInitialMemoryState();
  const sourceRefs = [{ messageId: 1, contentHash: `sha256:${"c".repeat(64)}` }];
  state.working.todos.push({ id: "todo:1", text: "还书", actor: "user", requester: "assistant", status: "active", becameOverdueAt: null, dueAt: null, sourceRefs, createdAtMessageId: 1, updatedAtMessageId: 1 });
  state.longTerm.userProfile.push({ id: "userProfile:1", text: "偏好安静", sourceRefs, createdAtMessageId: 1, updatedAtMessageId: 1 });

  const messages = [
    { id: 3, role: "assistant", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content: "记得还书", contentHash: `sha256:${"a".repeat(64)}` },
    { id: 4, role: "user", createdAt: "2026-07-12T00:01:00.000Z", contentKind: "raw", content: "好", contentHash: `sha256:${"b".repeat(64)}` },
  ];
  const envelope = buildNormalEnvelope({ userId: 1, presetId: "default", state, intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 3 }, messages, now: "2026-07-12T00:02:00Z", taskId: "task-1", tickId: 9, config });
  assert.equal(envelope.task.targetMessageId, 4);
  assert.deepEqual(envelope.task.observedMessageIds, [3, 4]);
  assert.match(envelope.artifact.publicInput.memoryText, /T1 \| 还书/);
  assert.equal(JSON.stringify(envelope.artifact.publicInput).includes("todo:1"), false);
  assert.equal(JSON.stringify(envelope.artifact.publicInput).includes("contentHash"), false);
  assert.equal(envelope.artifact.refMap.writable.T1.itemId, "todo:1");
  assert.equal(envelope.artifact.messageMeta["4"].contentHash, messages[1].contentHash);
  assert.equal(normalDedupeKey(envelope.task), "normal:0:todos:3:4");
});
