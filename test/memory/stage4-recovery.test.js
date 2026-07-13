const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { createMemoryRecovery } = require("../../modules/memory/application/recovery");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/stage4-recovery.json"), "utf8"));
const fixedNow = new Date("2026-07-13T00:00:00.000Z");
const message = { id: 1, role: "user", createdAt: fixedNow.toISOString(), contentKind: "raw", content: "今天先不记录", contentHash: "sha256:test" };
const config = {
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } },
  overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 1000, maxRenderedChars: 1000 },
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
    source: { getObservedWindow: async () => [message], getByIds: async () => [{ ...message, userId: 1, presetId: "default" }] },
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
    sidecars: { insertTombstone: async () => {} },
  };
  return { repositories, inspect: { tasks, groups, snapshots, events, ops, statuses, get state() { return state; } }, bumpRevision() { state.meta.revision += 1; }, failAt(point) { failurePoint = point; } };
}

test("stage 4 fixture applies bounded retry backoff and halts only the failing target", async () => {
  const data = store();
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  for (const expected of fixture.providerErrors) {
    const result = await pipeline.recordAdapterError(envelope, { status: "error", reason: expected.reason });
    const target = data.inspect.statuses.get("todos");
    assert.equal(target.status, expected.expectedStatus);
    assert.equal(target.consecutive_errors, expected.expectedConsecutiveErrors);
    assert.equal(result.notBefore === null ? null : Date.parse(result.notBefore) - fixedNow.getTime(), expected.expectedDelayMs);
  }
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.snapshots.length, 0);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), fixture.providerErrors.map((entry) => entry.reason));
});

test("provider retryMax halts even before the broader consecutive-error circuit breaker", async () => {
  const data = store();
  const strictConfig = { ...config, providerRecovery: { ...config.providerRecovery, retryMax: 0, haltAfterConsecutiveErrors: 3 } };
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config: strictConfig, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  const result = await pipeline.recordAdapterError(envelope, { status: "error", reason: "llm_call_failed" });
  assert.equal(result.halted, true);
  assert.equal(result.consecutiveErrors, 1);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
});

test("output schema invalid retries once durably and commits a valid second result", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope) => {
      calls += 1;
      if (calls === 1) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$.sectionResults" }] } };
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "committed");
  assert.equal(calls, 2);
  assert.equal(task.attempt, 1);
  assert.equal(data.inspect.ops[0].outcome, "output_schema_invalid_retry");
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
});

test("a second output schema invalid halts without a third provider call", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async () => {
      calls += 1;
      return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$" }] } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.halted, true);
  assert.equal(calls, 2);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), ["output_schema_invalid_retry", "output_schema_invalid"]);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
});

test("input schema invalid never retries", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async () => {
      calls += 1;
      return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: [{ path: "$.task" }] } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.halted, true);
  assert.equal(calls, 1);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), ["output_schema_invalid"]);
});

test("schema retry allowance remains consumed after an interrupted process", async () => {
  const data = store();
  let calls = 0;
  let interrupted = true;
  const providerAdapter = { propose: async () => {
    calls += 1;
    if (calls === 1) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$" }] } };
    if (interrupted) throw new Error("simulated process interruption");
    return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$" }] } };
  } };
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow, providerAdapter });
  const envelope = await pipeline.createTask(1, "default", intent);
  await assert.rejects(() => pipeline.processEnvelope(envelope), /simulated process interruption/);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).stage_payload.schemaInvalidAttempts, 1);
  interrupted = false;
  const result = await pipeline.processEnvelope(envelope);
  assert.equal(result.halted, true);
  assert.equal(calls, 3, "recovery may call once but must not grant another schema retry");
});

test("unable_to_decide expands once, then commits one cursor-only revision idempotently", async () => {
  const data = store();
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "unable_to_decide" } } });
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  const first = await pipeline.commit(envelope, outputFor(envelope));
  const second = await pipeline.commit(envelope, outputFor(envelope));
  const duplicate = await pipeline.commit(envelope, outputFor(envelope));
  assert.equal(first.status, fixture.unableToDecide.firstStatus);
  assert.equal(second.status, fixture.unableToDecide.secondStatus);
  assert.equal(duplicate.duplicate, true);
  assert.equal(data.inspect.state.meta.revision, fixture.unableToDecide.revisionAfter);
  assert.equal(data.inspect.state.meta.targetCursors.todos, fixture.unableToDecide.cursorAfter);
  assert.equal(data.inspect.groups.size, 1);
  assert.equal(data.inspect.events.length, 0);
  assert.equal(data.inspect.snapshots.length, 1);
});

test("revision mismatch cancels the old task and reproposes through a successor", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope) => { calls += 1; if (calls === 1) data.bumpRevision(); return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } }; } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const rows = [...data.inspect.tasks.values()];
  assert.equal(result.status, "committed");
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "cancelled");
  assert.equal(rows[1].predecessor_task_id, rows[0].task_id);
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.state.meta.targetCursors.todos, 1);
});

test("second unable_to_decide cannot advance a cursor from a stale base revision", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope) => {
      calls += 1;
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: calls < 3 ? "unable_to_decide" : "noop" } } } };
    } },
  });
  const first = await pipeline.processIntent(1, "default", intent);
  assert.equal(first.status, "context_expansion_required");
  data.bumpRevision();
  const original = [...data.inspect.tasks.values()][0].task_payload;
  const result = await pipeline.processEnvelope(original);
  const tasks = [...data.inspect.tasks.values()];
  assert.equal(result.status, "committed");
  assert.equal(calls, 3);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, "cancelled");
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.state.meta.targetCursors.todos, 1);
});

test("restart recovery reuses immutable payload and committed phase identity", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow, providerAdapter: { propose: async (envelope) => { calls += 1; return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } }; } } });
  await pipeline.createTask(1, "default", intent);
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline, now: () => fixedNow });
  const [first] = await recovery.recoverPending();
  const task = [...data.inspect.tasks.values()][0];
  task.status = "running";
  const [second] = await recovery.recoverPending();
  assert.equal(first.status, "committed");
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
  assert.equal(data.inspect.groups.size, 1);
  assert.equal(data.inspect.snapshots.length, 1);
});

test("one broken durable task does not starve later recoverable tasks", async () => {
  const envelopes = ["first", "second"].map((taskId) => ({ task: { taskId, userId: 1, presetId: "default", targetKey: "todos" } }));
  const repositories = {
    runtime: { async listRecoverableTasks() { return envelopes.map((task_payload) => ({ status: "queued", target_key: "todos", task_payload })); } },
    async withTransaction(work) { return work({}); },
  };
  const pipeline = { async processEnvelope(envelope) { if (envelope.task.taskId === "first") throw new Error("broken task"); return { status: "committed", taskId: "second" }; } };
  const recovery = createMemoryRecovery({ repositories, pipeline });
  const results = await recovery.recoverPending();
  assert.equal(results[0].status, "dispatch_failed");
  assert.deepEqual(results[1], { status: "committed", taskId: "second" });
});

test("unknown COMMIT outcome reconciles the stable phase before any retry write", async () => {
  const data = store();
  let calls = 0;
  const providerAdapter = { propose: async (envelope) => { calls += 1; return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } }; } };
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow, providerAdapter });
  const envelope = await pipeline.createTask(1, "default", intent);
  const ordinaryTransaction = data.repositories.withTransaction;
  let disconnectAfterCommit = true;
  data.repositories.withTransaction = async (work) => {
    const result = await work({ query: async () => ({ rows: [] }) });
    if (disconnectAfterCommit) {
      disconnectAfterCommit = false;
      const error = new Error("connection lost after COMMIT was sent");
      error.commitOutcomeUnknown = true;
      throw error;
    }
    return result;
  };
  const result = await pipeline.processEnvelope(envelope);
  data.repositories.withTransaction = ordinaryTransaction;
  assert.equal(result.reconciledCommitOutcome, true);
  assert.equal(calls, 1);
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.groups.size, 1);
  assert.equal(data.inspect.snapshots.length, 1);
});

test("manual resume requeues the existing retry task without changing semantic state", async () => {
  const data = store();
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  await pipeline.recordAdapterError(envelope, { status: "error", reason: "llm_call_failed" });
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline, now: () => fixedNow });
  const result = await recovery.resumeTarget(1, "default", "todos");
  const task = data.inspect.tasks.get(envelope.task.taskId);
  assert.equal(result.status, "queued");
  assert.equal(task.status, "queued");
  assert.equal(task.not_before, null);
  assert.equal(data.inspect.statuses.get("todos").status, "retry_wait");
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.snapshots.length, 0);
});

test("fault injection rolls back every revision write boundary without a partial cursor or duplicate", async () => {
  for (const point of ["state", "eventGroup", "events", "snapshot", "task", "targetStatus"]) {
    const data = store();
    const providerAdapter = { propose: async (envelope) => ({ status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } }) };
    const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow, providerAdapter });
    const envelope = await pipeline.createTask(1, "default", intent);
    data.failAt(point);
    const result = await pipeline.processEnvelope(envelope);
    assert.equal(result.outcome, "transaction_failed", point);
    assert.equal(data.inspect.state.meta.revision, 0, point);
    assert.equal(data.inspect.state.meta.targetCursors.todos, undefined, point);
    assert.equal(data.inspect.groups.size, 0, point);
    assert.equal(data.inspect.events.length, 0, point);
    assert.equal(data.inspect.snapshots.length, 0, point);
    assert.equal(data.inspect.ops.at(-1).outcome, "transaction_failed", point);
  }
});
