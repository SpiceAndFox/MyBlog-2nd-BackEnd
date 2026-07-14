const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { createMemoryMetrics } = require("../../modules/memory/application/metrics");

function budgets() {
  return Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
}
const config = {
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } },
  overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, sectionBudgets: budgets(),
};
const content = "我答应明天还书";
const message = { id: 1, role: "user", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content, contentHash: `sha256:${crypto.createHash("sha256").update(content).digest("hex")}` };

function fakes() {
  let state = createInitialMemoryState();
  const tasks = new Map();
  const groups = new Map();
  const events = [];
  const snapshots = [];
  const statuses = [];
  return {
    inspect: { get state() { return state; }, tasks, groups, events, snapshots, statuses },
    repositories: {
      withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
      state: {
        getState: async () => structuredClone(state),
        writeState: async (_u, _p, value) => { state = structuredClone(value); },
      },
      source: { getObservedWindow: async () => [message], getByIds: async () => [{ ...message, userId: 1, presetId: "default" }] },
      runtime: {
        createTask: async (row) => { const existing = [...tasks.values()].find((task) => task.dedupe_key === row.dedupe_key); if (existing) return existing; tasks.set(row.task_id, structuredClone(row)); return row; },
        getTask: async (id) => tasks.get(id) || null,
        getTaskForUpdate: async (id) => tasks.get(id),
        updateTask: async (id, changes) => Object.assign(tasks.get(id), changes),
        upsertTargetStatus: async (_u, _p, status) => statuses.push(structuredClone(status)),
        appendOpsLog: async () => {},
      },
      audit: {
        getEventGroup: async (id) => groups.get(id) || null,
        insertEventGroup: async (group) => { groups.set(group.event_group_id, structuredClone(group)); },
        insertEvents: async (rows) => events.push(...structuredClone(rows)),
        insertSnapshot: async (_u, _p, snapshot) => snapshots.push(structuredClone(snapshot)),
      },
      sidecars: { insertTombstone: async () => {} },
    },
  };
}

test("normal task atomically persists state, event group, snapshot, task and target status", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "lagThreshold" } };
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "patches", patches: [{ op: "addItem", value: { text: "归还书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 } }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "答应明天还书" }] }] } } });
  const pipeline = createNormalWritePipeline({
    observer: { observe: async () => ({ eligibleTasks: [intent] }) }, config, repositories: store.repositories,
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: outputFor(envelope) }) },
    now: () => new Date("2026-07-12T00:01:00Z"), idFactory: (() => { const ids = ["patch", "item"]; return () => ids.shift(); })(),
  });
  const [result] = await pipeline.processScope(1, "default");
  assert.equal(result.status, "committed");
  assert.equal(store.inspect.state.meta.revision, 1);
  assert.equal(store.inspect.state.meta.targetCursors.todos, 1);
  assert.equal(store.inspect.state.working.todos[0].id, "todo:item");
  assert.equal(store.inspect.groups.size, 1);
  assert.equal(store.inspect.events[0].decision, "accepted");
  assert.equal(store.inspect.events[0].patch_summary.op, "addItem");
  assert.equal(store.inspect.snapshots.length, 1);
  assert.equal([...store.inspect.tasks.values()][0].status, "succeeded");
  assert.equal(store.inspect.statuses.at(-1).status, "healthy");
});

test("proposal-triggered cleanup persists the target item id", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "lagThreshold" } };
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "patches", patches: [{ op: "addItem", value: { text: "归还书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 } }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "答应明天还书" }] }] } } });
  const pipeline = createNormalWritePipeline({
    observer: { observe: async () => ({ eligibleTasks: [intent] }) }, config, repositories: store.repositories,
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: outputFor(envelope) }) },
    now: () => new Date("2026-07-14T00:01:00Z"), idFactory: (() => { const ids = ["patch", "item"]; return () => ids.shift(); })(),
  });
  const [result] = await pipeline.processScope(1, "default");
  const cleanup = store.inspect.events.find((event) => event.cleanup_type === "todo_became_overdue");
  assert.equal(result.status, "committed");
  assert.equal(store.inspect.state.working.todos[0].status, "overdue");
  assert.equal(cleanup.item_id, "todo:item");
  assert.equal(cleanup.item_id, cleanup.normalized_operation.itemId);
});

test("task envelope freezes the User time zone and Reducer resolves calendar dates with it", async () => {
  const store = fakes();
  store.repositories.users = { getTimeZone: async () => "Asia/Shanghai" };
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 };
  const metrics = createMemoryMetrics();
  const pipeline = createNormalWritePipeline({
    observer: {}, config, repositories: store.repositories, metrics,
    providerAdapter: { propose: async (envelope) => ({ status: "ok", model: "test", usage: { input_tokens: 10, output_tokens: 5 }, output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "patches", patches: [{ op: "addItem", value: { text: "归还书", actor: "user", requester: "user", dueAt: { mode: "absolute", date: "2026-07-13" } }, evidenceKind: "user_commitment", evidenceRefs: [{ messageId: 1, quote: "答应明天还书" }] }] } } } }) },
    now: () => new Date("2026-07-12T00:01:00Z"), idFactory: (() => { const ids = ["patch", "item"]; return () => ids.shift(); })(),
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const envelope = [...store.inspect.tasks.values()][0].task_payload;
  assert.equal(result.status, "committed");
  assert.equal(envelope.task.userTimeZone, "Asia/Shanghai");
  assert.equal(store.inspect.state.working.todos[0].dueAt, "2026-07-13T16:00:00.000Z");
  assert.equal(metrics.snapshot().counters["memory_quote_validation_total{result=accepted,targetKey=todos}"], 1);
});

test("repeated commit phase returns the existing revision without duplicate writes", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 };
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: store.repositories, config, idFactory: () => "id" });
  const envelope = await pipeline.createTask(1, "default", intent);
  const output = { tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "noop" } } };
  const first = await pipeline.commit(envelope, output);
  const second = await pipeline.commit(envelope, output);
  assert.equal(first.revision, 1);
  assert.equal(second.duplicate, true);
  assert.equal(store.inspect.groups.size, 1);
  assert.equal(store.inspect.snapshots.length, 1);
  assert.equal(store.inspect.state.meta.revision, 1);
});

test("unable_to_decide retry doubles overlap context and completes the same durable task", async () => {
  const store = fakes();
  store.inspect.state.meta.targetCursors.todos = 1;
  const older = { ...message, id: 1, content: "之前提到过一本书", contentHash: "sha256:older" };
  const newer = { ...message, id: 2 };
  let expansionOptions = null;
  store.repositories.source.getObservedWindow = async () => [newer];
  store.repositories.source.getForceDrainWindow = async (_u, _p, cursor, boundary, options) => {
    assert.equal(cursor, 1);
    assert.equal(boundary, 2);
    expansionOptions = options;
    return [older, newer];
  };
  store.repositories.source.getByIds = async (_u, _p, ids) => [older, newer]
    .filter((entry) => ids.includes(entry.id))
    .map((entry) => ({ ...entry, userId: 1, presetId: "default" }));
  const observedCounts = [];
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: store.repositories, config,
    providerAdapter: { propose: async (envelope) => {
      observedCounts.push(envelope.observedMessages.length);
      return { status: "ok", output: {
        tickId: envelope.task.tickId,
        proposer: envelope.task.proposer,
        sectionResults: { todos: { status: observedCounts.length === 1 ? "unable_to_decide" : "noop" } },
      } };
    } },
  });
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 1 };
  const first = await pipeline.processIntent(1, "default", intent);
  assert.equal(first.status, "context_expansion_required");
  const envelope = [...store.inspect.tasks.values()][0].task_payload;
  const second = await pipeline.processEnvelope(envelope);
  assert.equal(second.status, "committed");
  assert.deepEqual(observedCounts, [1, 2]);
  assert.deepEqual(expansionOptions, { newBatchSize: 1, contextWindow: 4 });
  assert.equal(store.inspect.state.meta.targetCursors.todos, 2);
});
