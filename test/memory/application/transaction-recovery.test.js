const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryRecovery } = require("../../../modules/memory/application/recovery");
const { fixedNow, config, intent, store } = require("../support/recovery-harness");

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

test("prepared rebuild wave commits in deterministic order and rolls back as one unit", async () => {
  const data = store();
  const waveConfig = structuredClone(config);
  waveConfig.targets.scene = { lagThreshold: 1, contextWindow: 2 };
  const providerAdapter = {
    propose: async (envelope) => ({
      status: "ok",
      output: {
        tickId: envelope.task.tickId,
        proposer: envelope.task.proposer,
        sectionResults: Object.fromEntries(envelope.task.targetSections.map((section) => [section, { status: "noop" }])),
      },
    }),
  };
  const pipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config: waveConfig,
    now: () => fixedNow,
    providerAdapter,
  });
  const sceneEnvelope = await pipeline.createTask(1, "default", {
    targetKey: "scene",
    proposer: "currentStateProposer",
    targetSections: ["scene"],
    trigger: { type: "forceDrain", sourceWatermark: 1 },
  });
  const todoEnvelope = await pipeline.createTask(1, "default", {
    targetKey: "todos",
    proposer: "todoProposer",
    targetSections: ["todos"],
    trigger: { type: "forceDrain", sourceWatermark: 1 },
  });
  const prepared = await Promise.all([
    pipeline.prepareEnvelope(todoEnvelope),
    pipeline.prepareEnvelope(sceneEnvelope),
  ]);
  assert.ok(prepared.every((entry) => entry.status === "prepared"));
  assert.equal(sceneEnvelope.task.baseRevision, todoEnvelope.task.baseRevision);

  data.failAt("snapshot");
  await assert.rejects(() => pipeline.commitPreparedWave(prepared), /injected:snapshot/);
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.state.meta.targetCursors.scene, undefined);
  assert.equal(data.inspect.state.meta.targetCursors.todos, undefined);
  assert.equal(data.inspect.groups.size, 0);
  assert.equal(data.inspect.snapshots.length, 0);
  assert.ok([...data.inspect.tasks.values()].every((task) => task.stage === "compiled_proposal_persisted"));

  const committed = await pipeline.commitPreparedWave(prepared);
  assert.equal(committed.status, "committed");
  assert.deepEqual(committed.results.map((entry) => entry.targetKey), ["scene", "todos"]);
  assert.deepEqual(committed.results.map((entry) => entry.revision), [1, 2]);
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.state.meta.targetCursors.scene, 1);
  assert.equal(data.inspect.state.meta.targetCursors.todos, 1);
  assert.deepEqual([...data.inspect.groups.values()].map((group) => [
    group.target_key,
    group.base_revision,
    group.result_revision,
  ]), [["scene", 0, 1], ["todos", 1, 2]]);
  assert.deepEqual(data.inspect.snapshots.map((snapshot) => snapshot.revision), [1, 2]);
});

test("prepared rebuild wave reconciles an unknown COMMIT outcome only when every phase exists", async () => {
  const data = store();
  const waveConfig = structuredClone(config);
  waveConfig.targets.scene = { lagThreshold: 1, contextWindow: 2 };
  const pipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config: waveConfig,
    now: () => fixedNow,
    providerAdapter: {
      propose: async (envelope) => ({
        status: "ok",
        output: {
          tickId: envelope.task.tickId,
          proposer: envelope.task.proposer,
          sectionResults: Object.fromEntries(envelope.task.targetSections.map((section) => [section, { status: "noop" }])),
        },
      }),
    },
  });
  const envelopes = await Promise.all([
    pipeline.createTask(1, "default", {
      targetKey: "scene", proposer: "currentStateProposer", targetSections: ["scene"],
      trigger: { type: "forceDrain", sourceWatermark: 1 },
    }),
    pipeline.createTask(1, "default", {
      targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"],
      trigger: { type: "forceDrain", sourceWatermark: 1 },
    }),
  ]);
  const prepared = await Promise.all(envelopes.map((envelope) => pipeline.prepareEnvelope(envelope)));
  const ordinaryTransaction = data.repositories.withTransaction;
  let injected = false;
  data.repositories.withTransaction = async (work) => {
    const result = await work({ query: async () => ({ rows: [] }) });
    if (!injected && data.inspect.groups.size === 2) {
      injected = true;
      const error = new Error("connection lost after wave COMMIT");
      error.commitOutcomeUnknown = true;
      throw error;
    }
    return result;
  };
  const committed = await pipeline.commitPreparedWave(prepared);
  data.repositories.withTransaction = ordinaryTransaction;
  assert.equal(committed.status, "committed");
  assert.equal(committed.reconciledCommitOutcome, true);
  assert.ok(committed.results.every((entry) => entry.duplicate && entry.reconciledCommitOutcome));
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.groups.size, 2);
  assert.equal(data.inspect.snapshots.length, 2);
});
