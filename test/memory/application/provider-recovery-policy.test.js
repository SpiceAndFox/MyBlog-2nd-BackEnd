const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMemoryProviderFailure } = require("../../../modules/memory/application/providerRecoveryPolicy");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { store, config, intent, fixedNow } = require("../support/recovery-harness");

const transient = { status: "error", reason: "llm_call_failed", detail: { status: 503 } };
const noop = envelope => ({ status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } });

test("provider failure classifier separates confirmed outages, permanent errors and unknown failures", () => {
  for (const detail of [{ code: "MEMORY_PROVIDER_TIMEOUT" }, { code: "ECONNRESET" }, { status: 429 }, { status: 503 }]) {
    assert.equal(classifyMemoryProviderFailure({ reason: "llm_call_failed", detail }).kind, "transient");
  }
  for (const detail of [{ status: 401 }, { retryable: false, status: 503 }, { code: "MEMORY_PROVIDER_INPUT_LIMIT" }, { code: "MODEL_NOT_FOUND", status: 500 }]) {
    assert.equal(classifyMemoryProviderFailure({ reason: "llm_call_failed", detail }).kind, "permanent");
  }
  assert.equal(classifyMemoryProviderFailure({ reason: "llm_call_failed", detail: {} }).kind, "bounded");
  assert.equal(classifyMemoryProviderFailure({ reason: "semantic_schema_invalid" }).kind, "permanent");
});

test("normal task survives repeated outages and process reconstruction without halting or advancing its cursor", async () => {
  const data = store(); let time = fixedNow.getTime(); let calls = 0;
  const make = () => createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => new Date(time),
    providerAdapter: { async propose(envelope) { return ++calls <= 5 ? transient : noop(envelope); } } });
  const envelope = await make().createTask(1, "default", intent);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await make().processEnvelope(envelope);
    assert.equal(result.halted, false); assert.equal(result.recoveryKind, "transient");
    assert.equal(data.inspect.state.meta.revision, 0);
    assert.equal(data.inspect.statuses.get("todos").consecutive_errors, 0);
    assert.equal((await make().processEnvelope(envelope)).status, "retry_wait");
    assert.equal(calls, attempt);
    time = Date.parse(result.notBefore);
  }
  assert.equal((await make().processEnvelope(envelope)).status, "committed");
  assert.equal(data.inspect.tasks.size, 1); assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).stage_payload.providerRecovery, undefined);
});

test("schema repair and provider failure budgets remain independent across a restart", async () => {
  const data = store(); let time = fixedNow.getTime(); let calls = 0;
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, schemaInvalidRetryMax: 2 } };
  const make = () => createNormalWritePipeline({ observer: {}, repositories: data.repositories, config: settings, now: () => new Date(time),
    providerAdapter: { async propose(envelope) {
      calls++;
      if (calls <= 2) return { status: "error", reason: "output_schema_invalid", rejectedOutput: { invalid: calls }, detail: { boundary: "output", errors: [{ path: "$" }] } };
      if (calls === 3) return transient;
      return noop(envelope);
    } } });
  const envelope = await make().createTask(1, "default", intent);
  const result = await make().processEnvelope(envelope);
  const task = data.inspect.tasks.get(envelope.task.taskId);
  assert.equal(result.halted, false); assert.equal(task.attempt, 3);
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.equal(task.stage_payload.providerRecovery, undefined);
  assert.equal(Date.parse(result.notBefore) - time, config.providerRecovery.backoffBaseMs);
  time = Date.parse(result.notBefore);
  assert.equal((await make().processEnvelope(envelope)).status, "committed");
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
});

test("permanent invocation failures halt immediately and existing failed tasks are never revived", async () => {
  const data = store(); let calls = 0;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { async propose() { calls++; return { ...transient, detail: { status: 401, retryable: false } }; } } });
  const envelope = await pipeline.createTask(1, "default", intent);
  assert.equal((await pipeline.processEnvelope(envelope)).halted, true);
  assert.equal((await pipeline.processEnvelope(envelope)).status, "failed");
  assert.equal(calls, 1); assert.equal(data.inspect.state.meta.revision, 0);
});

test("Retry-After is a durable lower bound that survives restarting the task executor", async () => {
  const data = store(); let calls = 0;
  const retryAfterAt = new Date(fixedNow.getTime() + 300_000).toISOString();
  const make = () => createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { async propose() { calls++; return { ...transient, detail: { status: 429, retryAfterAt } }; } } });
  const envelope = await make().createTask(1, "default", intent);
  assert.equal((await make().processEnvelope(envelope)).notBefore, retryAfterAt);
  assert.equal((await make().processEnvelope(envelope)).notBefore, retryAfterAt);
  assert.equal(calls, 1);
});
