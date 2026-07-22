const test = require("node:test");
const assert = require("node:assert/strict");
const { createMigrationProviderTelemetry } = require("../../../modules/memory/application/migrationTelemetry");

function envelope({ taskId = "task-1", mode = "normal", proposer = "todoProposer" } = {}) {
  return { task: { taskId, targetKey: "todos", proposer, mode } };
}

test("migration telemetry counts actual retries, maintenance calls, and tokens", async () => {
  let clock = 0;
  const outputs = [
    {
      status: "error", reason: "output_schema_invalid", model: "deepseek-v4-flash",
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 10, completion_tokens: 20, total_tokens: 120 },
    },
    {
      status: "ok", model: "deepseek-v4-flash",
      usage: { input_tokens: 50, output_tokens: 5 },
    },
    {
      status: "ok", model: "deepseek-v4-flash",
      usage: { input_tokens: 40, output_tokens: 4 },
    },
  ];
  const telemetry = createMigrationProviderTelemetry({
    expectedModel: "deepseek-v4-flash",
    monotonicNow: () => (clock += 5),
  });
  const durableAttempts = [0, 1, 0];
  const adapter = telemetry.wrapAdapter(
    { propose: async () => outputs.shift() },
    { loadTaskAttempt: async () => durableAttempts.shift() },
  );

  const mark = telemetry.mark();
  await adapter.propose(envelope());
  await adapter.propose(envelope());
  await adapter.propose(envelope({ taskId: "maintenance-1", mode: "maintenance", proposer: "compactionProposer" }));
  const report = telemetry.snapshot(mark);

  assert.equal(report.callCount, 3);
  assert.equal(report.retryCallCount, 1);
  assert.equal(report.retryClassificationCoverageComplete, true);
  assert.equal(report.inputTokens, 190);
  assert.equal(report.cachedInputTokens, 10);
  assert.equal(report.outputTokens, 29);
  assert.equal(report.totalTokens, 219);
  assert.equal(report.byMode.normal.callCount, 2);
  assert.equal(report.byMode.maintenance.callCount, 1);
  assert.equal(report.byResult.output_schema_invalid.callCount, 1);
  assert.equal(report.byProposer.compactionProposer.callCount, 1);
});

test("migration telemetry makes missing token coverage explicit after a thrown call", async () => {
  const telemetry = createMigrationProviderTelemetry({ expectedModel: "deepseek-v4-flash" });
  const adapter = telemetry.wrapAdapter({ propose: async () => { throw new Error("network down"); } });
  await assert.rejects(() => adapter.propose(envelope()), /network down/);
  const report = telemetry.snapshot();
  assert.equal(report.callCount, 1);
  assert.equal(report.tokenUsageMissingCallCount, 1);
  assert.equal(report.retryClassificationCoverageComplete, false);
  assert.equal(report.byResult.thrown.callCount, 1);
});

test("migration telemetry preserves schema repair options", async () => {
  const telemetry = createMigrationProviderTelemetry({ expectedModel: "deepseek-v4-flash" });
  let received;
  const adapter = telemetry.wrapAdapter({
    async propose(_envelope, options) {
      received = options;
      return { status: "ok", model: "deepseek-v4-flash", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const repairFeedback = { attempt: 1, errors: [{ path: "$.dueAt", message: "invalid" }] };
  await adapter.propose(envelope(), { repairFeedback });
  assert.deepEqual(received, { repairFeedback });
});

test("migration telemetry resolves the expected model from each proposer when the provider omits it", async () => {
  const telemetry = createMigrationProviderTelemetry({
    expectedModel: (value) => value.task.proposer === "profileRelationshipProposer" ? "profile-model" : "default-model",
  });
  const adapter = telemetry.wrapAdapter({
    propose: async () => ({ status: "error", reason: "llm_call_failed" }),
  });
  await adapter.propose(envelope());
  await adapter.propose(envelope({ taskId: "task-2", proposer: "profileRelationshipProposer" }));
  const report = telemetry.snapshot();
  assert.equal(report.byModel["default-model"].callCount, 1);
  assert.equal(report.byModel["profile-model"].callCount, 1);
});
