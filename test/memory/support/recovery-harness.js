const crypto = require("node:crypto");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");

const recoveryScenario = Object.freeze({
  providerErrors: [
    { reason: "llm_call_failed", expectedStatus: "retry_wait", expectedDelayMs: 1000, expectedConsecutiveErrors: 1 },
    { reason: "max_output_truncated", expectedStatus: "retry_wait", expectedDelayMs: 2000, expectedConsecutiveErrors: 2 },
    { reason: "safety_policy_blocked", expectedStatus: "halted", expectedDelayMs: null, expectedConsecutiveErrors: 3 },
  ],
  unableToDecide: {
    firstStatus: "context_expansion_required",
    secondStatus: "committed",
    cursorAfter: 1,
    revisionAfter: 1,
  },
});
const fixedNow = new Date("2026-07-13T00:00:00.000Z");
const messageContent = "今天先不记录";
const message = {
  id: 1,
  role: "user",
  createdAt: fixedNow.toISOString(),
  contentKind: "raw",
  content: messageContent,
  contentHash: `sha256:${crypto.createHash("sha256").update(messageContent, "utf8").digest("hex")}`,
};
const config = {
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } },
  overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  scene: { ttlMs: 1000, maxRenderedChars: 1000 },
  sectionBudgets: Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((key) => [key, { maxItems: 20, maxRenderedChars: 2000 }])),
  providerRecovery: { retryMax: 2, schemaInvalidRetryMax: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, haltAfterConsecutiveErrors: 3 },
};
const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], trigger: { type: "lagThreshold" } };

function store() {
  let state = createInitialMemoryState();
  let failurePoint = null;
  const tasks = new Map();
  const groups = new Map();
  const snapshots = [];
  const events = [];
  const ops = [];
  const statuses = new Map([["todos", { target_key: "todos", source_generation: 0, status: "healthy", consecutive_errors: 0 }]]);
  function maybeFail(point) { if (failurePoint === point) { failurePoint = null; throw new Error(`injected:${point}`); } }
  function restoreMap(target, values) { target.clear(); for (const [key, value] of values) target.set(key, value); }
  const repositories = {
    withTransaction: async (work) => {
      const before = { state: structuredClone(state), tasks: structuredClone([...tasks]), groups: structuredClone([...groups]), snapshots: structuredClone(snapshots), events: structuredClone(events), ops: structuredClone(ops), statuses: structuredClone([...statuses]) };
      try { return await work({ query: async () => ({ rows: [] }) }); }
      catch (error) {
        state = before.state; restoreMap(tasks, before.tasks); restoreMap(groups, before.groups); restoreMap(statuses, before.statuses);
        snapshots.splice(0, snapshots.length, ...before.snapshots); events.splice(0, events.length, ...before.events); ops.splice(0, ops.length, ...before.ops);
        throw error;
      }
    },
    state: { getState: async () => structuredClone(state), writeState: async (_u, _p, next) => { maybeFail("state"); state = structuredClone(next); } },
    source: { getObservedWindow: async () => [message], getForceDrainWindow: async () => [message], getByIds: async () => [{ ...message, userId: 1, presetId: "default" }] },
    runtime: {
      createTask: async (row) => { const old = [...tasks.values()].find((item) => item.dedupe_key === row.dedupe_key); if (old) return old; tasks.set(row.task_id, structuredClone(row)); return tasks.get(row.task_id); },
      getTask: async (id) => tasks.get(id) ?? null,
      getTaskForUpdate: async (id) => tasks.get(id) ?? null,
      updateTask: async (id, changes) => { if (changes.stage === "committed") maybeFail("task"); return Object.assign(tasks.get(id), structuredClone(changes)); },
      getTargetStatus: async (_u, _p, key) => statuses.get(key) ?? null,
      getTargetStatuses: async () => [...statuses.values()],
      upsertTargetStatus: async (_u, _p, value) => { maybeFail("targetStatus"); statuses.set(value.targetKey, { target_key: value.targetKey, source_generation: value.sourceGeneration, status: value.status, consecutive_errors: value.consecutiveErrors, last_error_reason: value.lastErrorReason, last_task_id: value.lastTaskId, next_retry_at: value.nextRetryAt }); },
      appendOpsLog: async (entry) => ops.push(structuredClone(entry)),
      listRecoverableTasks: async () => [...tasks.values()].filter((task) => ["queued", "running", "retry_wait"].includes(task.status)),
      listTasksForTarget: async () => [...tasks.values()].reverse(),
    },
    audit: { getEventGroup: async (id) => groups.get(id) ?? null, insertEventGroup: async (group) => { maybeFail("eventGroup"); groups.set(group.event_group_id, structuredClone(group)); }, insertEvents: async (rows) => { maybeFail("events"); events.push(...structuredClone(rows)); }, insertSnapshot: async (_u, _p, value) => { maybeFail("snapshot"); snapshots.push(structuredClone(value)); } },
    sidecars: {},
  };
  return { repositories, inspect: { tasks, groups, snapshots, events, ops, statuses, get state() { return state; } }, bumpRevision() { state.meta.revision += 1; }, failAt(point) { failurePoint = point; } };
}

module.exports = { recoveryScenario, fixedNow, config, intent, store };
