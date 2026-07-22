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
