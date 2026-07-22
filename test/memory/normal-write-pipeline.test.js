const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { createMemoryMetrics } = require("../../modules/memory/application/metrics");
const { createMemoryTestConfig, sha256 } = require("./support/memory-builders");

const config = createMemoryTestConfig({
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } },
  providerRecovery: { retryMax: 2, schemaInvalidRetryMax: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, haltAfterConsecutiveErrors: 3 },
  compaction: { retryMax: 1 },
});
const content = "我答应明天还书";
const message = { id: 1, role: "user", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content, contentHash: sha256(content) };

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
        createTask: async (row) => { const existing = [...tasks.values()].find((task) => task.dedupe_key === row.dedupe_key); if (existing) return existing; tasks.set(row.task_id, { ...structuredClone(row), created_at: "2026-07-12T00:00:00.000Z" }); return tasks.get(row.task_id); },
        getTask: async (id) => tasks.get(id) || null,
        getTaskForUpdate: async (id) => tasks.get(id),
        updateTask: async (id, changes) => Object.assign(tasks.get(id), changes),
        getTargetStatus: async (_u, _p, targetKey) => statuses.findLast((row) => row.targetKey === targetKey) || { targetKey, status: "healthy", consecutiveErrors: 0 },
        upsertTargetStatus: async (_u, _p, status) => statuses.push(structuredClone(status)),
        appendOpsLog: async () => {},
      },
      audit: {
        getEventGroup: async (id) => groups.get(id) || null,
        insertEventGroup: async (group) => { groups.set(group.event_group_id, structuredClone(group)); },
        insertEvents: async (rows) => events.push(...structuredClone(rows)),
        insertSnapshot: async (_u, _p, snapshot) => snapshots.push(structuredClone(snapshot)),
      },
      sidecars: {},
    },
  };
}

test("normal task atomically persists state, event group, snapshot, task and target status", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "lagThreshold" } };
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "changes", changes: [{ action: "add", text: "归还书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 }, anchorMessageId: 1, evidenceMessageIds: [1] }] } } });
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
  const task = [...store.inspect.tasks.values()][0];
  assert.equal(task.status, "succeeded");
  assert.equal(task.stage_payload.semanticInputVariant, "base");
  assert.equal(task.stage_payload.unableResult, undefined);
  assert.equal(store.inspect.statuses.at(-1).status, "healthy");
});

test("proposal-triggered cleanup persists the target item id", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "lagThreshold" } };
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "changes", changes: [{ action: "add", text: "归还书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 }, anchorMessageId: 1, evidenceMessageIds: [1] }] } } });
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
    providerAdapter: { propose: async (envelope) => ({ status: "ok", model: "test", usage: { input_tokens: 10, output_tokens: 5 }, output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "changes", changes: [{ action: "add", text: "归还书", actor: "user", requester: "user", dueAt: { mode: "absolute", date: "2026-07-13" }, evidenceMessageIds: [1] }] } } } }) },
    now: () => new Date("2026-07-12T00:01:00Z"), idFactory: (() => { const ids = ["patch", "item"]; return () => ids.shift(); })(),
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const envelope = [...store.inspect.tasks.values()][0].task_payload;
  assert.equal(result.status, "committed");
  assert.equal(envelope.task.userTimeZone, "Asia/Shanghai");
  assert.equal(store.inspect.state.working.todos[0].dueAt, "2026-07-13T16:00:00.000Z");
  const metricSnapshot = metrics.snapshot();
  assert.equal(metricSnapshot.counters["memory_provider_results_total{proposer=todoProposer,result=ok,targetKey=todos}"], 1);
  assert.equal(metricSnapshot.counters["memory_provider_observed_messages_total{proposer=todoProposer,targetKey=todos}"], 1);
  assert.equal(metricSnapshot.observations["memory_provider_calls_per_message{proposer=todoProposer,targetKey=todos}"].average, 1);
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

test("a persisted proposal is reused after recovery without another provider call", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 };
  let providerCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: store.repositories, config,
    providerAdapter: { async propose() { providerCalls += 1; throw new Error("provider must not be called"); } },
  });
  const envelope = await pipeline.createTask(1, "default", intent);
  const output = { tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "noop" } } };
  await pipeline.persistSemanticResult(envelope, output);
  const result = await pipeline.processEnvelope(envelope);
  assert.equal(result.status, "committed");
  assert.equal(providerCalls, 0);
  assert.equal(store.inspect.state.meta.targetCursors.todos, 1);
});

test("adapter metrics retain each bounded result reason without raw provider details", async () => {
  for (const reason of ["llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid"]) {
    const store = fakes();
    const metrics = createMemoryMetrics();
    const pipeline = createNormalWritePipeline({
      observer: {}, repositories: store.repositories, config, metrics,
      providerAdapter: { async propose() { return { status: "error", reason, detail: { boundary: "input", raw: "must-not-be-a-label" } }; } },
      now: () => new Date("2026-07-12T00:01:00.000Z"),
    });
    await pipeline.processIntent(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"] });
    const key = `memory_provider_results_total{proposer=todoProposer,result=${reason},targetKey=todos}`;
    assert.equal(metrics.snapshot().counters[key], 1, reason);
    assert.equal(Object.keys(metrics.snapshot().counters).some((metric) => metric.includes("must-not-be-a-label")), false);
    if (reason === "output_schema_invalid") {
      assert.equal(metrics.snapshot().counters["memory_target_halted_total{reason=output_schema_invalid,targetKey=todos}"], 1);
      assert.equal(metrics.snapshot().observations["memory_workflow_age_ms{targetKey=todos,workflow=halt}"].max, 60_000);
    }
  }
});

test("force-drain compiles authoritative historical source messages without a suppression gate", async () => {
  const store = fakes();
  const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "forceDrain" } };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: store.repositories, config,
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: {
      tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "changes", changes: [{
        action: "add", text: "归还书", actor: "user", requester: "user", evidenceMessageIds: [1],
      }] } },
    } }) },
    idFactory: (() => { const ids = ["patch", "item"]; return () => ids.shift(); })(),
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.status, "committed");
  assert.equal(store.inspect.events[0].decision, "accepted");
  assert.equal(store.inspect.state.working.todos.length, 1);
});

test("unable_to_decide retry doubles overlap context and completes the same durable task", async () => {
  const store = fakes();
  const localConfig = structuredClone(config);
  store.inspect.state.meta.targetCursors.todos = 1;
  const older = { ...message, id: 1, content: "之前提到过一本书", contentHash: sha256("之前提到过一本书") };
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
    observer: {}, repositories: store.repositories, config: localConfig,
    providerAdapter: { propose: async (envelope) => {
      observedCounts.push(envelope.artifact.publicInput.messages.length);
      if (observedCounts.length === 1) localConfig.targets.todos.contextWindow = 99;
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
  const task = [...store.inspect.tasks.values()][0];
  const envelope = task.task_payload;
  assert.equal(task.stage_payload.normalContextWindow, 2);
  assert.deepEqual(task.stage_payload.expandedArtifact.publicInput.messages.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(Object.keys(task.stage_payload.expandedArtifact).sort(), ["messageMeta", "publicInput"]);
  assert.equal(task.stage_payload.semanticResult, undefined);
  assert.equal(task.stage_payload.unableResult.sectionResults.todos.status, "unable_to_decide");
  store.repositories.source.getForceDrainWindow = async () => { throw new Error("durable expanded input must be reused"); };
  const second = await pipeline.processEnvelope(envelope);
  assert.equal(second.status, "committed");
  assert.deepEqual(observedCounts, [1, 2]);
  assert.deepEqual(expansionOptions, { newBatchSize: 1, contextWindow: 4 });
  assert.deepEqual(task.stage_payload.expandedArtifact.publicInput.messages.map((entry) => entry.id), [1, 2]);
  assert.equal(task.stage_payload.semanticInputVariant, "expanded");
  assert.equal(store.inspect.state.meta.targetCursors.todos, 2);
});

test("legacy durable unable Semantic result is reclassified without Provider or Compiler work", async () => {
  const store = fakes();
  let providerCalls = 0;
  let compilerCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: store.repositories, config,
    providerAdapter: { propose: async () => { providerCalls += 1; throw new Error("must not call Provider"); } },
    semanticCompiler: { compile: async () => { compilerCalls += 1; throw new Error("must not call Compiler"); } },
  });
  const envelope = await pipeline.createTask(1, "default", {
    targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0,
  });
  const task = store.inspect.tasks.get(envelope.task.taskId);
  task.stage = "semantic_result_persisted";
  task.status = "running";
  task.stage_payload.semanticResult = {
    tickId: envelope.task.tickId,
    proposer: envelope.task.proposer,
    sectionResults: { todos: { status: "unable_to_decide" } },
  };

  const result = await pipeline.processEnvelope(envelope);
  assert.equal(result.status, "context_expansion_required");
  assert.equal(providerCalls, 0);
  assert.equal(compilerCalls, 0);
  assert.equal(task.stage_payload.semanticResult, undefined);
  assert.equal(task.stage_payload.unableResult.sectionResults.todos.status, "unable_to_decide");
  assert.ok(task.stage_payload.expandedArtifact);
});
