const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createRetryBudget } = require("../../../modules/memory/application/retryBudget");
const { beginManualRetrySession } = require("../../../modules/memory/application/manualRetrySession");
const { createProviderRequestControl } = require("../../../modules/memory/application/providerRequestRecovery");
const { createProviderHealth } = require("../../../shared/observability/providerHealth");
const { store, config, intent, fixedNow } = require("../support/recovery-harness");

const transient = () => ({ status: "error", reason: "llm_call_failed", detail: { status: 503 } });
const invalid = () => ({ status: "error", reason: "output_schema_invalid", rejectedOutput: { invalid: true },
  detail: { boundary: "output", errors: [{ path: "$", message: "invalid" }] } });
const noop = envelope => ({ status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer,
  sectionResults: { todos: { status: "noop" } } } });

test("a late provider response recognizes a concurrent commit instead of reporting cursor mismatch", async () => {
  const data = store(); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const options = { observer: {}, repositories: data.repositories, config, now: () => fixedNow };
  const slow = createNormalWritePipeline({ ...options, providerAdapter: { async propose(envelope) {
    started(); await pending; return noop(envelope);
  } } });
  const fast = createNormalWritePipeline({ ...options, providerAdapter: { propose: async envelope => noop(envelope) } });
  const envelope = await slow.createTask(1, "default", intent);
  const late = slow.prepareEnvelope(envelope);
  await ready;
  assert.equal((await fast.processEnvelope(envelope)).status, "committed");
  release();
  const result = await late;
  assert.equal(result.status, "committed");
  assert.equal(result.duplicate, true);
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).status, "succeeded");
  assert.equal(data.inspect.ops.some(op => op.outcome === "stale_result"), false);
});

test("late responses cannot reopen cancelled work or hide a genuine cursor conflict", async () => {
  for (const cancelled of [true, false]) {
    const data = store();
    const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow,
      providerAdapter: { async propose(envelope) {
        if (cancelled) data.inspect.tasks.get(envelope.task.taskId).status = "cancelled";
        else {
          const state = structuredClone(data.inspect.state); state.meta.targetCursors.todos = 99;
          await data.repositories.state.writeState(1, "default", state);
        }
        return noop(envelope);
      } } });
    const envelope = await pipeline.createTask(1, "default", intent);
    const result = await pipeline.processEnvelope(envelope);
    assert.equal(result.status, cancelled ? "cancelled" : "stale");
    if (!cancelled) assert.equal(result.reason, "cursor_mismatch");
    assert.equal(data.inspect.state.meta.revision, 0);
  }
});

test("rebasing a prepared wave cannot clear a target halt", async () => {
  const h = harness(noop);
  const envelope = await h.pipeline.createTask(1, "default", intent);
  await h.pipeline.prepareEnvelope(envelope);
  h.inspect.statuses.get("todos").status = "halted";
  await h.pipeline.cancelPreparedWave([envelope], "wave_baseline_mismatch");
  assert.equal(h.inspect.statuses.get("todos").status, "halted");
  assert.equal(h.inspect.state.meta.targetCursors.todos ?? 0, 0);
});

function harness(propose, recovery = {}) {
  const data = store();
  const retryBudget = createRetryBudget();
  let time = fixedNow.getTime();
  let calls = 0;
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, ...recovery } };
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config: settings,
    retryBudget, now: () => new Date(time), providerAdapter: { propose: (...args) => { calls++; return propose(...args); } } });
  return { ...data, pipeline, retryBudget, settings, calls: () => calls,
    advance: result => { time = Date.parse(result.notBefore); } };
}

for (const [kind, failure, setting, extra] of [
  ["transient", transient, "transientRetryMax", 2],
  ["unknown", () => ({ status: "error", reason: "llm_call_failed" }), "retryMax", 2],
  ["schema", invalid, "schemaInvalidRetryMax", 1],
]) test(`${kind} exhaustion stops this execution; a new manual session resumes the same task and generation`, async () => {
  let recovered = false;
  const h = harness(envelope => recovered ? noop(envelope) : failure(), { [setting]: extra });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  let result;
  do {
    result = await h.pipeline.processEnvelope(envelope);
    if (!result.halted) h.advance(result);
  } while (!result.halted);
  const task = h.inspect.tasks.get(envelope.task.taskId);
  assert.equal(h.calls(), extra + 1);
  assert.equal(task.stage, "retry_budget_exhausted");
  assert.equal((await h.pipeline.processEnvelope(envelope)).status, "failed");
  assert.equal(h.calls(), extra + 1);
  assert.equal(h.inspect.state.meta.revision, 0);
  assert.equal(h.inspect.state.meta.targetCursors.todos ?? 0, 0);
  const attempts = task.attempt;
  const history = structuredClone(task.stage_payload?.schemaRejectedOutputs);
  recovered = true;
  await beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 0);
  assert.equal(task.status, "queued");
  assert.equal(task.attempt, attempts);
  assert.deepEqual(task.stage_payload?.schemaRejectedOutputs, history);
  assert.equal((await h.pipeline.processEnvelope(envelope)).status, "committed");
  assert.equal(h.calls(), extra + 2);
  assert.equal(h.inspect.tasks.size, 1);
  assert.equal(h.inspect.state.meta.sourceGeneration, 0);
  assert.equal(h.inspect.state.meta.targetCursors.todos, 1);
  assert.equal(task.stage_payload.providerRecovery, undefined);
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.equal(h.inspect.ops.filter(op => op.outcome === "manual_retry_session").length, 1);
});

test("old durable counters and cumulative attempt cannot consume a new execution's allowance", async () => {
  const h = harness(transient, { transientRetryMax: 1 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  const task = h.inspect.tasks.get(envelope.task.taskId);
  task.attempt = 100;
  task.stage_payload.providerRecovery = { version: 1, transientFailures: 100, boundedFailures: 100 };
  task.stage_payload.schemaInvalidAttempts = 100;
  const first = await h.pipeline.processEnvelope(envelope);
  assert.equal(first.halted, false);
  assert.equal(task.attempt, 101);
  h.advance(first);
  assert.equal((await h.pipeline.processEnvelope(envelope)).halted, true);
  assert.equal(h.calls(), 2);
});

test("a new task id for the same logical work cannot refresh an exhausted allowance", async () => {
  const h = harness(transient, { transientRetryMax: 0 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  assert.equal((await h.pipeline.processEnvelope(envelope)).halted, true);
  const counts = structuredClone(h.retryBudget.forTask(envelope.task));
  const successor = await h.pipeline.createTask(1, "default", intent, { dedupeSuffix: "replacement" });
  assert.notEqual(successor.task.taskId, envelope.task.taskId);
  assert.equal((await h.pipeline.processEnvelope(successor)).halted, true);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.retryBudget.forTask(successor.task), counts, "scheduling checks must not add failures");
});

test("queue deferrals and checks before notBefore do not consume a zero-retry budget", async () => {
  let round = 0;
  const h = harness(() => ++round <= 3 ? { status: "deferred", reason: "provider_queue_full" } : transient(), { transientRetryMax: 0 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  for (let i = 0; i < 3; i++) {
    const result = await h.pipeline.processEnvelope(envelope);
    assert.equal(result.status, "retry_wait");
    assert.equal(h.inspect.tasks.get(envelope.task.taskId).attempt, 0);
    await h.pipeline.processEnvelope(envelope);
    assert.equal(h.calls(), i + 1);
    h.advance(result);
  }
  assert.equal((await h.pipeline.processEnvelope(envelope)).halted, true);
  assert.equal(h.inspect.tasks.get(envelope.task.taskId).attempt, 1);
});

test("HTTP recovery clears connectivity failures while invalid output retains the schema allowance", async () => {
  const sequence = [transient(), invalid(), transient(), invalid()];
  const h = harness(() => sequence.shift(), { transientRetryMax: 1, schemaInvalidRetryMax: 1 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  h.advance(await h.pipeline.processEnvelope(envelope));
  const second = await h.pipeline.processEnvelope(envelope);
  assert.equal(second.halted, false);
  const counts = h.retryBudget.forTask(envelope.task);
  assert.equal(counts.transientFailures, 1);
  assert.equal(counts.schemaFailures, 1);
  h.advance(second);
  assert.equal((await h.pipeline.processEnvelope(envelope)).halted, true);
  assert.equal(h.calls(), 4);
  assert.equal(counts.transientFailures, 0);
  assert.equal(counts.schemaFailures, 2);
});

test("valid output resets all failure categories without resetting cumulative history", async () => {
  const h = harness(noop);
  const envelope = await h.pipeline.createTask(1, "default", intent);
  const counts = h.retryBudget.forTask(envelope.task);
  Object.assign(counts, { transientFailures: 1, boundedFailures: 1, transportFailures: 1, schemaFailures: 1 });
  h.inspect.tasks.get(envelope.task.taskId).attempt = 17;
  assert.equal((await h.pipeline.processEnvelope(envelope)).status, "committed");
  assert.deepEqual(Object.values(counts), [0, 0, 0, 0]);
  assert.equal(h.inspect.tasks.get(envelope.task.taskId).attempt, 17);
});

test("changing error categories does not count as a provider success", async () => {
  const sequence = [transient(), { status: "error", reason: "llm_call_failed" }, transient()];
  const h = harness(() => sequence.shift(), { transientRetryMax: 1 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  h.advance(await h.pipeline.processEnvelope(envelope));
  h.advance(await h.pipeline.processEnvelope(envelope));
  assert.equal((await h.pipeline.processEnvelope(envelope)).halted, true);
  assert.equal(h.calls(), 3);
});

test("manual session leaves correctness halts, other generations and other scopes unchanged", async () => {
  const h = harness(transient, { transientRetryMax: 0 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  await h.pipeline.processEnvelope(envelope);
  const task = h.inspect.tasks.get(envelope.task.taskId);
  task.stage = "compile_failed";
  task.last_error_reason = "compile_invariant_failed";
  const other = h.retryBudget.forTask({ ...envelope.task, presetId: "another" });
  other.transientFailures = 9;
  await beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 0);
  assert.equal(task.status, "failed");
  assert.equal(h.inspect.statuses.get("todos").status, "halted");
  assert.equal(other.transientFailures, 9);
  task.stage = "retry_budget_exhausted";
  task.source_generation = 99;
  await beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 0);
  assert.equal(task.status, "failed");
});

test("privacy and generation gates reject a new session before reopening work or resetting allowances", async () => {
  const h = harness(transient, { transientRetryMax: 0 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  await h.pipeline.processEnvelope(envelope);
  h.repositories.privacy = { hasIncompleteOperation: async () => true };
  await assert.rejects(beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 0), { code: "MEMORY_PRIVACY_OPERATION_PENDING" });
  assert.equal(h.retryBudget.exhausted(envelope.task, h.settings), true);
  assert.equal(h.inspect.tasks.get(envelope.task.taskId).status, "failed");
  await assert.rejects(beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 2), { code: "MEMORY_REBUILD_STALE" });
});

test("manual retry does not reopen historical failures after the target has moved on", async () => {
  const h = harness(transient, { transientRetryMax: 0 });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  await h.pipeline.processEnvelope(envelope);
  h.inspect.statuses.get("todos").status = "healthy";
  await beginManualRetrySession(h.repositories, h.retryBudget, 1, "default", 0);
  assert.equal(h.inspect.tasks.get(envelope.task.taskId).status, "failed");
  assert.equal(h.inspect.statuses.get("todos").status, "healthy");
});

test("request failures are bounded independently; another task is never suppressed by provider health", async () => {
  const budget = createRetryBudget();
  const health = createProviderHealth({ name: "memory" });
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, transientRetryMax: 1 } };
  const control = createProviderRequestControl({ health, retryBudget: budget, config: settings, now: () => fixedNow });
  const task = { userId: 1, presetId: "default", sourceGeneration: 0, targetKey: "todos", mode: "normal", cursorBefore: 0, targetMessageId: 1 };
  let failedCalls = 0;
  const fail = async () => { failedCalls++; throw Object.assign(new Error("unavailable"), { status: 503 }); };
  await assert.rejects(control(fail, { proposer: "todoProposer" }, task), e => e.providerDecision.halted === false);
  await assert.rejects(control(fail, { proposer: "todoProposer" }, task), e => e.providerDecision.budgetExhausted === true);
  await assert.rejects(control(fail, { proposer: "todoProposer" }, task), e => e.noProviderCall === true);
  assert.equal(failedCalls, 2);
  assert.equal(health.snapshot().status, "degraded");
  assert.equal(await control(async () => "ok", { proposer: "todoProposer" }, { ...task, targetMessageId: 2 }), "ok");
  assert.equal(health.snapshot().status, "healthy");
  await assert.rejects(control(fail, { proposer: "todoProposer" }, task), e => e.noProviderCall === true);
  assert.equal(failedCalls, 2, "another task's success must not reset this task's failure allowance");
});

test("request success resets consecutive network failures even if no Memory commit has happened", async () => {
  const budget = createRetryBudget();
  const control = createProviderRequestControl({ health: createProviderHealth({ name: "memory" }), retryBudget: budget,
    config: { ...config, providerRecovery: { ...config.providerRecovery, transientRetryMax: 1 } }, now: () => fixedNow });
  const task = { taskId: "same", targetKey: "todos", mode: "normal" };
  const fail = () => { throw Object.assign(new Error("offline"), { status: 503 }); };
  for (let i = 0; i < 4; i++) {
    await assert.rejects(control(fail, { proposer: "todoProposer" }, task), e => e.providerDecision.halted === false);
    await control(async () => ({ output: null }), { proposer: "todoProposer" }, task);
  }
});

test("cancellation after an invalid output prevents the next schema request and keeps repair history", async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return invalid(); });
  const envelope = await h.pipeline.createTask(1, "default", intent);
  const result = await h.pipeline.processEnvelope(envelope, { signal: controller.signal });
  assert.equal(result.outcome, "operation_interrupted");
  assert.equal(h.calls(), 1);
  assert.equal(h.inspect.state.meta.revision, 0);
  assert.equal(h.inspect.tasks.get(envelope.task.taskId).stage, "schema_invalid_retry");
  assert.ok(h.inspect.tasks.get(envelope.task.taskId).stage_payload.schemaRepairFeedback);
});
