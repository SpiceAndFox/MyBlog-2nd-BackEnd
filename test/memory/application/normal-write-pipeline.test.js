const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryMetrics } = require("../../../modules/memory/application/metrics");
const { createMemoryTestConfig, sha256 } = require("../support/memory-builders");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { loadProposerPrompt } = require("../../../modules/memory/prompts");
const { replayEventGroups } = require("../../../modules/memory/domain/eventReplay");
const { buildMaintenanceEnvelope } = require("../../../modules/memory/application/envelope");
const { maintenanceTaskRow } = require("../../../modules/memory/application/capacityMaintenance");

const config = createMemoryTestConfig({
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } },
  providerRecovery: { retryMax: 2, transportInvalidRetryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, haltAfterConsecutiveErrors: 3 },
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

for (const recoveryPath of ["parent", "child", "wave"]) {
  test(`legacy todo capacity recovery through ${recoveryPath} skips compaction and remains retryable`, async () => {
    const store = fakes();
    store.inspect.state.working.todos = [{
      id: "todo:old", text: "旧约定", actor: "user", requester: "user", status: "active", dueAt: null, becameOverdueAt: null,
      createdAtMessageId: 0, updatedAtMessageId: 1, sourceRefs: [{ messageId: 1, contentHash: message.contentHash }],
    }];
    const capacityConfig = createMemoryTestConfig({ ...config, sectionBudgets: { todos: { maxItems: 1 } } });
    const pipeline = createNormalWritePipeline({ observer: {}, repositories: store.repositories, config: capacityConfig,
      now: () => new Date("2026-07-12T00:01:00Z"),
      providerAdapter: { propose: async () => { throw new Error("legacy capacity recovery must not call a provider"); } },
    });
    const parent = await pipeline.createTask(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], trigger: { type: "lagThreshold" } });
    const violation = { section: "todos", dimension: "maxItems", limit: 1, actual: 2 };
    const child = buildMaintenanceEnvelope({ parentEnvelope: parent, state: store.inspect.state, section: "todos", violation, config: capacityConfig });
    await store.repositories.runtime.createTask(maintenanceTaskRow(child));
    await store.repositories.runtime.updateTask(child.task.taskId, { status: "retry_wait", not_before: "2099-01-01T00:00:00.000Z" });
    await store.repositories.runtime.updateTask(parent.task.taskId, { status: "running", stage: "capacity_blocked", stage_payload: {
      maintenanceTaskId: child.task.taskId, blockingViolation: violation, attemptedSections: [],
      compiledProposal: { tickId: parent.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "patches", patches: [{
        op: "addItem", value: { text: "新约定", actor: "user", requester: "user", dueAt: null }, sourceRefs: [{ messageId: 1, contentHash: message.contentHash }],
      }] } } },
    } });
    if (recoveryPath === "wave") {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.equal((await pipeline.resolvePreparedWaveCapacity(parent)).status, "capacity_resolved");
        assert.equal(store.inspect.state.meta.revision, 0, "a wave must repropose before advancing any parent");
        assert.equal(store.inspect.groups.size, 0);
      }
    } else {
      const result = await pipeline.processEnvelope(recoveryPath === "parent" ? parent : child);
      assert.equal(result.status, "committed");
      assert.deepEqual(store.inspect.state.working.todos.map(item => item.text), ["新约定"]);
      assert.equal(store.inspect.state.meta.targetCursors.todos, 1);
      assert.equal(store.inspect.state.meta.revision, 1);
      assert.equal((await pipeline.processEnvelope(child)).duplicate, true);
      assert.equal(store.inspect.state.meta.revision, 1);
    }
    assert.equal(store.inspect.tasks.get(child.task.taskId).status, "cancelled");
    assert.equal(store.inspect.tasks.get(child.task.taskId).last_error_reason, "todo_capacity_policy_changed");
  });
}

for (const wave of [false, true]) {
  test(`todo overflow commits FIFO eviction with the whole ${wave ? "rebuild wave" : "normal proposal"} and never compacts`, async () => {
    const store = fakes();
    store.inspect.state.working.todos = ["a", "b"].map(id => ({
      id: `todo:${id}`, text: `旧约定${id}`, actor: "user", requester: "user", status: "active",
      dueAt: null, becameOverdueAt: null, createdAtMessageId: 0, updatedAtMessageId: 1,
      sourceRefs: [{ messageId: 1, contentHash: message.contentHash }],
    }));
    const initial = structuredClone(store.inspect.state);
    const capacityConfig = createMemoryTestConfig({ ...config, sectionBudgets: { todos: { maxItems: 2 } } });
    let calls = 0;
    const pipeline = createNormalWritePipeline({ observer: {}, config: capacityConfig, repositories: store.repositories,
      now: () => new Date("2026-07-12T00:01:00Z"),
      providerAdapter: { propose: async envelope => {
        calls += 1;
        assert.equal(envelope.task.proposer, "todoProposer", "capacity must never call compaction");
        return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: {
          status: "changes", changes: ["还书", "买花"].map(text => ({ action: "add", text, actor: "user", requester: "user", evidenceMessageIds: [1] })),
        } } } };
      } },
    });
    const envelope = await pipeline.createTask(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], trigger: { type: wave ? "forceDrain" : "lagThreshold" } });
    const result = wave
      ? await pipeline.commitPreparedWave([await pipeline.prepareEnvelope(envelope)])
      : await pipeline.processEnvelope(envelope);
    assert.equal(result.status, "committed");
    assert.equal(calls, 1);
    assert.deepEqual(store.inspect.state.working.todos.map(item => item.text), ["还书", "买花"]);
    assert.equal(store.inspect.state.meta.revision, 1);
    assert.equal(store.inspect.state.meta.targetCursors.todos, 1);
    assert.equal(store.inspect.tasks.size, 1);
    assert.equal(store.inspect.groups.size, 1);
    assert.deepEqual(store.inspect.events.map(event => event.decision), ["accepted", "accepted", "system_cleanup", "system_cleanup"]);
    assert.deepEqual(store.inspect.events.filter(event => event.cleanup_type).map(event => [event.cleanup_type, event.item_id]), [
      ["todo_capacity_evicted", "todo:a"], ["todo_capacity_evicted", "todo:b"],
    ]);
    assert.deepEqual(replayEventGroups(initial, [...store.inspect.groups.values()], store.inspect.events), store.inspect.state);
    assert.deepEqual(store.inspect.snapshots[0].state, store.inspect.state);
    const duplicate = await pipeline.processEnvelope(envelope);
    assert.equal(duplicate.duplicate, true);
    assert.equal(calls, 1);
    assert.equal(store.inspect.state.meta.revision, 1);
  });
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

test("Todo pipeline persists actual schema metadata across schema repair and commit", async () => {
  const store = fakes();
  const requests = [];
  const metrics = createMemoryMetrics();
  const providerAdapter = createMemoryProviderAdapter({ promptLoader: loadProposerPrompt, invokeStructured: async request => {
    requests.push(request);
    return { output: requests.length === 1
      ? { results: { todos: { status: "changes", changes: [{ action: "add", sources: ["message:1"], text: "还书", actor: "user", requester: "user" }] } } }
      : { results: { todos: { status: "changes", changes: [] } } } };
  } });
  const pipeline = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, providerAdapter, metrics,
    now: () => new Date("2026-07-12T00:01:00Z") });
  const result = await pipeline.processIntent(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 });
  assert.equal(result.status, "committed");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].responseSchema, requests[1].responseSchema);
  assert.match(requests[1].repairContext.userMessage, /results\.todos\.changes\[0\]\.due/);
  const row = [...store.inspect.tasks.values()][0];
  assert.equal(Object.hasOwn(row.task_payload.task, "outputProtocol"), false);
  assert.equal(row.stage_payload.providerProtocol.outputProtocol, "todo");
  assert.equal(row.stage_payload.providerProtocol.rawSchemaValid, false);
  assert.deepEqual(row.stage_payload.providerProtocol.normalizations, [{ code: "EMPTY_CHANGES_TO_NOOP", section: "todos" }]);
  assert.equal(row.stage_payload.schemaRejectedOutputs[0].protocol.schemaHash, row.stage_payload.providerProtocol.schemaHash);
  assert.equal(row.stage_payload.semanticResult.sectionResults.todos.status, "noop");
  assert.equal(metrics.snapshot().counters["memory_provider_wire_normalizations_total{outputChannel=adapter,outputProtocol=todo,rawSchemaValid=false,targetKey=todos}"], 1);
});

test("persisted current Todo tasks resume using the official schema and prompt", async () => {
  const store = fakes();
  const requests = [];
  const providerAdapter = createMemoryProviderAdapter({ promptLoader: loadProposerPrompt, invokeStructured: async request => {
    requests.push(request);
    return { output: { results: { todos: { status: "noop" } } } };
  } });
  const pipeline = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, providerAdapter,
    now: () => new Date("2026-07-12T00:01:00Z") });
  const envelope = await pipeline.createTask(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 });
  const row = store.inspect.tasks.get(envelope.task.taskId);
  const restored = JSON.parse(JSON.stringify(row.task_payload));
  const result = await pipeline.processEnvelope(restored);
  assert.equal(result.status, "committed");
  assert.equal(requests[0].responseSchema.name, "memory_todo");
  assert.equal(requests[0].systemPrompt, await loadProposerPrompt("todoProposer", restored.task));
  assert.equal(row.stage_payload.providerProtocol.outputProtocol, "todo");
});

test("incompatible Todo repair state halts without provider calls, counter resets, or memory writes", async () => {
  for (const withCandidate of [false, true]) {
    const store = fakes();
    let calls = 0;
    const providerAdapter = createMemoryProviderAdapter({ promptLoader: loadProposerPrompt,
      invokeStructured: async () => { calls++; throw new Error("must not call provider"); } });
    const pipeline = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, providerAdapter,
      now: () => new Date("2026-07-12T00:01:00Z") });
    const envelope = await pipeline.createTask(1, "default", {
      targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0,
    });
    const row = store.inspect.tasks.get(envelope.task.taskId);
    Object.assign(row, { status: "running", stage: "schema_invalid_retry", attempt: 2, stage_payload: {
      schemaInvalidAttempts: 1, transportInvalidAttempts: 1,
      schemaRepairFeedback: { attempt: 2, inputVariant: "base",
        errors: [{ path: "$.changes[0].dueMode", message: "invalid" }],
        plan: { expectedShape: { sectionStatuses: { todos: "changes" }, changes: "array" } },
      },
      schemaRejectedOutputs: withCandidate ? [{ attempt: 1, available: true,
        output: { sectionStatuses: { todos: "changes" }, changes: [] } }] : [],
    } });
    const previousStage = structuredClone(row.stage_payload);
    const previousState = structuredClone(store.inspect.state);
    const previousEnvelope = structuredClone(row.task_payload);
    const result = await pipeline.processEnvelope(JSON.parse(JSON.stringify(row.task_payload)));
    assert.equal(result.halted, true);
    assert.equal(result.reason, "output_schema_invalid");
    assert.equal(result.detail.code, "MEMORY_REPAIR_CONTEXT_INVALID");
    assert.equal(result.detail.boundary, "input");
    assert.equal(calls, 0);
    assert.equal(row.status, "failed");
    assert.equal(row.attempt, 3, "the existing input-error policy records one failure");
    assert.deepEqual(row.stage_payload, previousStage);
    assert.deepEqual(row.task_payload, previousEnvelope);
    assert.deepEqual(store.inspect.state, previousState);
    assert.equal(store.inspect.groups.size, 0);
    assert.equal(store.inspect.events.length, 0);
    assert.equal(store.inspect.snapshots.length, 0);
  }
});

for (const participantConflict of [false, true]) test(`Todo business rejection repairs ${participantConflict ? "combined constraints during force drain" : "the date conflict"} before evidence-only commit`, async () => {
  const store = fakes();
  const messages = [
    { ...message, id: 1, createdAt: "2026-01-01T12:00:00.000Z" },
    { ...message, id: 2, createdAt: "2026-01-02T12:00:00.000Z", content: "只是再次确认原计划，没有改期", contentHash: sha256("只是再次确认原计划，没有改期") },
  ];
  store.repositories.source.getObservedWindow = async () => messages;
  store.repositories.source.getByIds = async (_u, _p, ids) => messages.filter(m => ids.includes(m.id)).map(m => ({ ...m, userId: 1, presetId: "default" }));
  const dueAt = "2026-01-03T00:00:00.000Z";
  store.inspect.state.meta.targetCursors.todos = 1;
  store.inspect.state.working.todos.push({ id: "todo:old", text: "归还书", actor: "user", requester: "user",
    status: "overdue", dueAt, becameOverdueAt: dueAt, sourceRefs: [{ messageId: 1, contentHash: message.contentHash }],
    createdAtMessageId: 1, updatedAtMessageId: 1 });
  const candidate = { results: { todos: { status: "changes", changes: [{ action: "revise", target: "T1", sources: ["message:1", "message:2"],
    text: { mode: "keep" }, actor: { mode: "keep" }, requester: { mode: "keep" },
    due: { mode: "relativeDays", offset: 1, anchorSource: "message:2" },
  }] } } };
  if (participantConflict) candidate.results.todos.changes[0].actor = { mode: "set", value: "assistant" };
  const repaired = structuredClone(candidate);
  repaired.results.todos.changes[0].due = { mode: "keep" };
  repaired.results.todos.changes[0].actor = { mode: "keep" };
  const requests = [];
  const providerAdapter = createMemoryProviderAdapter({ promptLoader: loadProposerPrompt, invokeStructured: async request => {
    requests.push(request);
    if (requests.length === 2) {
      assert.deepEqual(request.repairContext.assistantOutput, candidate);
      const instruction = request.repairContext.userMessage;
      for (const value of ["$.results.todos.changes[0].due", "T1", dueAt, "2026-01-04T00:00:00.000Z", "2026-09-10T00:00:00.000Z"]) assert.ok(instruction.includes(value), value);
      assert.match(instruction, /不得为了通过校验编造未来日期/);
      assert.match(instruction, /若只补充证据/);
      if (participantConflict) {
        assert.match(instruction, /TODO_OVERDUE_PARTICIPANT_CHANGE/);
        assert.match(instruction, /\$\.results\.todos\.changes\[0\]\.actor\.value/);
      }
      assert.doesNotMatch(instruction, /sectionResults|dueChange|todo:old/);
    }
    return { output: requests.length === 1 ? candidate : repaired, model: "test", outputChannel: "tool_arguments",
      usage: { prompt_tokens: 100, completion_tokens: 30 }, transportRecovery: "test-recovery" };
  } });
  const pipeline = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, providerAdapter,
    now: () => new Date("2026-09-10T00:00:00.000Z") });
  const result = await pipeline.processIntent(1, "default", { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 1,
    ...(participantConflict ? { trigger: { type: "forceDrain" } } : {}) });
  assert.equal(result.status, "committed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].systemPrompt, await loadProposerPrompt("todoProposer"));
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt, "business repair adds no persistent prompt rules");
  const row = [...store.inspect.tasks.values()][0];
  const rejected = row.stage_payload.schemaRejectedOutputs[0];
  assert.equal(rejected.outputKind, "provider_wire");
  assert.deepEqual(rejected.output, candidate);
  assert.equal(rejected.protocol.rawSchemaValid, true);
  assert.equal(rejected.protocol.transportRecovery, "test-recovery");
  assert.equal(rejected.protocol.schemaHash, row.stage_payload.providerProtocol.schemaHash);
  const issue = row.stage_payload.schemaRepairFeedback.errors[0];
  assert.equal(issue.code, "TODO_OVERDUE_REQUIRES_FUTURE_DUE");
  assert.equal(issue.path, "$.results.todos.changes[0].due");
  assert.equal(issue.meta.target, "T1");
  assert.equal(issue.meta.currentDueAt, dueAt);
  assert.equal(row.stage_payload.schemaRepairFeedback.errors.length, participantConflict ? 2 : 1);
  const todo = store.inspect.state.working.todos[0];
  assert.equal(todo.status, "overdue");
  assert.equal(todo.dueAt, dueAt);
  assert.equal(todo.becameOverdueAt, dueAt);
  assert.equal(todo.actor, "user");
  assert.deepEqual(todo.sourceRefs.map(ref => ref.messageId), [1, 2]);
  assert.equal(store.inspect.state.meta.targetCursors.todos, 2);
});

test("an open provider circuit durably sleeps work instead of polling the same task", async () => {
  const store = fakes();
  const intent = {
    targetKey: "todos",
    proposer: "todoProposer",
    targetSections: ["todos"],
    cursorBefore: 0,
    trigger: { type: "lagThreshold" },
  };
  const nextRetryAt = "2026-07-12T00:02:00.000Z";
  const pipeline = createNormalWritePipeline({
    observer: { observe: async () => ({ eligibleTasks: [intent] }) },
    config,
    repositories: store.repositories,
    providerAdapter: {
      async propose() {
        return {
          status: "deferred",
          reason: "provider_circuit_open",
          providerHealth: { status: "degraded", nextRetryAt },
        };
      },
    },
    now: () => new Date("2026-07-12T00:01:00.000Z"),
  });

  const [result] = await pipeline.processScope(1, "default");
  const task = [...store.inspect.tasks.values()][0];

  assert.deepEqual(result, {
    status: "retry_wait",
    outcome: "provider_circuit_open",
    taskId: task.task_id,
    notBefore: nextRetryAt,
  });
  assert.equal(task.status, "retry_wait");
  assert.equal(task.stage, "provider_circuit_open");
  assert.equal(task.not_before, nextRetryAt);
  assert.equal(task.attempt, 0);
  assert.equal(store.inspect.statuses.at(-1).status, "retry_wait");
  assert.equal(store.inspect.statuses.at(-1).nextRetryAt, nextRetryAt);
});

test("a provider circuit requiring attention durably halts deferred work", async () => {
  const store = fakes();
  const pipeline = createNormalWritePipeline({
    observer: {
      observe: async () => ({
        eligibleTasks: [{
          targetKey: "todos",
          proposer: "todoProposer",
          targetSections: ["todos"],
          cursorBefore: 0,
          trigger: { type: "lagThreshold" },
        }],
      }),
    },
    config,
    repositories: store.repositories,
    providerAdapter: {
      async propose() {
        return {
          status: "deferred",
          reason: "provider_circuit_open",
          providerHealth: { status: "needs_attention", nextRetryAt: null },
        };
      },
    },
  });

  const [result] = await pipeline.processScope(1, "default");
  const task = [...store.inspect.tasks.values()][0];

  assert.equal(result.status, "halted");
  assert.equal(task.status, "failed");
  assert.equal(task.stage, "provider_circuit_open");
  assert.equal(task.attempt, 0);
  assert.equal(store.inspect.statuses.at(-1).status, "halted");
  assert.equal(store.inspect.statuses.at(-1).nextRetryAt, null);
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
  store.repositories.userTimeZones = { getTimeZone: async () => "Asia/Shanghai" };
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
    providerAdapter: createMemoryProviderAdapter({ promptLoader: loadProposerPrompt, invokeStructured: async (request) => {
      assert.equal(request.responseSchema.name, "memory_todo");
      observedCounts.push(request.userPayload.messages.length);
      if (observedCounts.length === 1) localConfig.targets.todos.contextWindow = 99;
      return { output: { results: { todos: { status: observedCounts.length === 1 ? "unable_to_decide" : "noop" } } } };
    } }),
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
  const baseSchemaHash = task.stage_payload.providerProtocol.schemaHash;
  assert.equal(task.stage_payload.providerProtocol.outputProtocol, "todo");
  store.repositories.source.getForceDrainWindow = async () => { throw new Error("durable expanded input must be reused"); };
  const second = await pipeline.processEnvelope(envelope);
  assert.equal(second.status, "committed");
  assert.deepEqual(observedCounts, [1, 2]);
  assert.deepEqual(expansionOptions, { newBatchSize: 1, contextWindow: 4 });
  assert.deepEqual(task.stage_payload.expandedArtifact.publicInput.messages.map((entry) => entry.id), [1, 2]);
  assert.equal(task.stage_payload.semanticInputVariant, "expanded");
  assert.equal(task.stage_payload.providerProtocol.outputProtocol, "todo");
  assert.notEqual(task.stage_payload.providerProtocol.schemaHash, baseSchemaHash);
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
