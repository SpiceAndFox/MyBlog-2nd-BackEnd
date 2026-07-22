const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryRecovery } = require("../../../modules/memory/application/recovery");
const { fixedNow, config, intent, store } = require("../support/recovery-harness");

test("2.01 pipeline rejects legacy task payloads before repository or Provider work", async () => {
  const data = store();
  let providerCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { async propose() { providerCalls += 1; return { status: "ok", output: {} }; } },
  });
  const legacyEnvelope = { task: { taskId: "legacy-task", schemaVersion: 2, mode: "normal" } };
  await assert.rejects(() => pipeline.processEnvelope(legacyEnvelope), (error) => error.code === "MEMORY_V201_CUTOVER_REQUIRED");
  assert.equal(providerCalls, 0);
  assert.equal(data.inspect.state.meta.revision, 0);
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
  let injected = false;
  data.repositories.withTransaction = async (work) => {
    const result = await work({ query: async () => ({ rows: [] }) });
    if (!injected && data.inspect.groups.size === 1) {
      injected = true;
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
