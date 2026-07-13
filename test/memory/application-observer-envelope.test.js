const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createObserver, canScheduleNormal } = require("../../modules/memory/application/observer");
const { buildNormalEnvelope, buildStateViews, normalDedupeKey } = require("../../modules/memory/application/envelope");

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

test("envelope redacts evidence and ids outside writable sections", () => {
  const state = createInitialMemoryState();
  state.working.todos.push({ id: "todo:1", text: "还书", actor: "user", requester: "assistant", status: "active", becameOverdueAt: null, dueAt: null, evidenceGroups: [{ evidenceKind: "assistant_request", refs: [] }], createdAtMessageId: 1, updatedAtMessageId: 1 });
  state.longTerm.userProfile.push({ id: "userProfile:1", text: "偏好: 安静", evidenceGroups: [], createdAtMessageId: 1, updatedAtMessageId: 1 });
  const views = buildStateViews(state, "todoProposer", ["todos"], config);
  assert.equal(views.writableState.working.todos[0].id, "todo:1");
  assert.equal("evidenceGroups" in views.writableState.working.todos[0], false);
  assert.equal("id" in views.readOnlyContext.longTerm.userProfile[0], false);

  const messages = [
    { id: 3, role: "assistant", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content: "记得还书", contentHash: `sha256:${"a".repeat(64)}` },
    { id: 4, role: "user", createdAt: "2026-07-12T00:01:00.000Z", contentKind: "raw", content: "好", contentHash: `sha256:${"b".repeat(64)}` },
  ];
  const envelope = buildNormalEnvelope({ userId: 1, presetId: "default", state, intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 3 }, messages, now: "2026-07-12T00:02:00Z", taskId: "task-1", tickId: 9, config });
  assert.equal(envelope.task.targetMessageId, 4);
  assert.deepEqual(envelope.task.observedMessageIds, [3, 4]);
  assert.equal(normalDedupeKey(envelope.task), "normal:0:todos:3:4");
});
