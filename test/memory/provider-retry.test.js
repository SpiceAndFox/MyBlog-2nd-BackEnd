const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { fixture, fixedNow, config, intent, store } = require("./support/recovery-harness");

test("recovery fixture applies bounded retry backoff and halts only the failing target", async () => {
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
  const repairFeedbacks = [];
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope, options) => {
      calls += 1;
      repairFeedbacks.push(options?.repairFeedback ?? null);
      if (calls === 1) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$.sectionResults", message: "is invalid" }], rawOutput: "must-not-persist" } };
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "committed");
  assert.equal(calls, 2);
  assert.equal(repairFeedbacks[0], null);
  assert.deepEqual(repairFeedbacks[1].errors, [{ path: "$.sectionResults", message: "is invalid" }]);
  assert.equal(task.attempt, 1);
  assert.deepEqual(task.stage_payload.schemaRepairFeedback, repairFeedbacks[1]);
  assert.equal(data.inspect.ops[0].outcome, "output_schema_invalid_retry");
  assert.deepEqual(data.inspect.ops[0].detail.repairFeedback, repairFeedbacks[1]);
  assert.doesNotMatch(JSON.stringify(task.stage_payload), /must-not-persist/);
  assert.doesNotMatch(JSON.stringify(data.inspect.ops[0]), /must-not-persist/);
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
  const repairFeedbacks = [];
  const providerAdapter = { propose: async (_envelope, options) => {
    calls += 1;
    repairFeedbacks.push(options?.repairFeedback ?? null);
    if (calls === 1) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$", message: "broken output" }] } };
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
  assert.equal(repairFeedbacks[0], null);
  assert.deepEqual(repairFeedbacks[1], repairFeedbacks[2], "recovery must reuse the durable repair feedback");
  assert.deepEqual(repairFeedbacks[2].errors, [{ path: "$", message: "broken output" }]);
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
