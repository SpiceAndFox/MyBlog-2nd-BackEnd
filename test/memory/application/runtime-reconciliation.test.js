const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime, startupRecoveryIssues } = require("../../../modules/memory/application/runtime");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");
const {
  createMemoryTestConfig,
  withLibrarianRepositoryStubs,
} = require("../support/memory-builders");

test("startup recovery reconciles Memory diagnostics without retrieval workers", async () => {
  const state = createInitialMemoryState();
  const projectionCalls = [];
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const repositories = {
    state: {
      async getState() { return structuredClone(state); },
      async initializeRevisionZero() { return structuredClone(state); },
      async listInitializedScopes() { return [{ userId: 1, presetId: "default" }]; },
    },
    source: {
      async countAfter() { return 0; },
      async getBoundary() { return 5; },
    },
    runtime: {
      async getTargetStatuses() { return []; },
      async listRecoverableTasks() { return []; },
    },
    audit: {},
    sidecars: { async listActiveDiagnostics() { return []; } },
    diagnosticProjection: {
      async lockCheckpoint(userId, presetId) { projectionCalls.push([userId, presetId]); return { processed_event_id: 0 }; },
      async listCommittedEventsAfter() { return []; },
      async advanceCheckpoint() {},
      async recordProjectionError() {},
    },
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
    }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });

  const firstReport = await runtime.recoverPending();
  assert.deepEqual(firstReport.tasks, []);
  assert.deepEqual(firstReport.issues, []);
  assert.deepEqual(projectionCalls, [[1, "default"]]);
  const secondReport = await runtime.recoverPending();
  assert.deepEqual(secondReport.tasks, []);
  assert.deepEqual(secondReport.issues, []);
  assert.deepEqual(projectionCalls, [[1, "default"], [1, "default"]]);
  const stop = runtime.startProjectionPolling();
  assert.equal(typeof stop, "function");
  assert.equal(runtime.startProjectionPolling(), runtime.stopProjectionPolling);
  stop();
});

test("diagnostic synchronization failures remain observable after retrieval retirement", async () => {
  const state = createInitialMemoryState();
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const errors = [];
  const repositories = {
    state: {
      async getState() { return structuredClone(state); },
      async initializeRevisionZero() { return structuredClone(state); },
      async listInitializedScopes() { return [{ userId: 1, presetId: "default" }]; },
    },
    source: { async countAfter() { return 0; } },
    runtime: { async getTargetStatuses() { return []; }, async listRecoverableTasks() { return []; } },
    audit: {},
    diagnosticProjection: {
      async lockCheckpoint() { return { processed_event_id: 0 }; },
      async listCommittedEventsAfter() { throw Object.assign(new Error("diagnostics failed"), { code: "DIAGNOSTICS_FAILED" }); },
      async advanceCheckpoint() {},
      async recordProjectionError() {},
    },
    sidecars: { async listActiveDiagnostics() { return []; } },
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
    }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
    onBackgroundError(error) { errors.push(error.code); },
  });

  const results = await runtime.reconcileProjections();
  assert.deepEqual(results["1:default"], {
    diagnostics: { status: "failed", reason: "DIAGNOSTICS_FAILED" },
  });
  assert.deepEqual(errors, ["DIAGNOSTICS_FAILED"]);
});

test("strict startup recovery classifies durable and projection work that cannot open readiness", () => {
  assert.deepEqual(startupRecoveryIssues({
    privacy: { "1:default": { status: "incomplete" } },
    rebuildBefore: { "1:default": { status: "skipped" } },
    tasks: [{ status: "retry_wait", taskId: "task-1" }, { status: "committed", taskId: "task-2" }],
    pendingTasks: [{ status: "retry_wait", task_id: "task-future" }],
    rebuildAfter: { "1:default": { status: "incomplete" } },
    projections: {
      "1:default": {
        diagnostics: { status: "failed" },
      },
    },
  }), [
    { kind: "privacy", scope: "1:default", status: "incomplete" },
    { kind: "rebuild_after", scope: "1:default", status: "incomplete" },
    { kind: "task", taskId: "task-1", status: "retry_wait" },
    { kind: "pending_task", taskId: "task-future", status: "retry_wait" },
    { kind: "projection", scope: "1:default", projectionKey: "diagnostics", status: "failed" },
  ]);
});

test("startup recovery resumes a persisted rebuilding boundary even when no task is pending", async () => {
  const state = createInitialMemoryState();
  const statuses = Object.fromEntries(TARGET_KEYS.map((key) => [key, { target_key: key, source_generation: 0, status: "rebuilding", rebuild_boundary_message_id: 0 }]));
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const repositories = {
    state: { async getState() { return structuredClone(state); }, async initializeRevisionZero() { return structuredClone(state); }, async listInitializedScopes() { return [{ userId: 1, presetId: "default" }]; } },
    source: { async countAfter() { return 0; } },
    runtime: {
      async getTargetStatuses() { return Object.values(statuses); }, async listRecoverableTasks() { return []; },
      async getTargetStatus(_u, _p, key) { return statuses[key]; },
      async upsertTargetStatus(_u, _p, value) { statuses[value.targetKey] = { ...statuses[value.targetKey], ...value, source_generation: value.sourceGeneration, rebuild_boundary_message_id: value.rebuildBoundaryMessageId, status: value.status }; },
    },
    audit: {
      async getSnapshot() { return { source_generation: 0, schema_version: "2.01", state: structuredClone(state) }; },
      async listSnapshots() { return [{ revision: 0, source_generation: 0, schema_version: "2.01", state: structuredClone(state) }]; },
      async listRevisionGroups() { return []; },
    },
    sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
    }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: {
      async propose(envelope) {
        return {
          status: "ok",
          output: {
            tickId: envelope.task.tickId,
            proposer: envelope.task.proposer,
            status: "noop",
            operations: [],
          },
        };
      },
    },
  });
  await runtime.recoverPending();
  assert.equal(Object.values(statuses).every((row) => row.status === "healthy" && row.rebuild_boundary_message_id === null), true);
});

test("generic rebuild reconciliation cannot bypass an incomplete privacy purge", async () => {
  const state = createInitialMemoryState();
  let targetReads = 0;
  const repositories = {
    state: { async listInitializedScopes() { return [{ userId: 1, presetId: "default" }]; }, async getState() { return state; }, async initializeRevisionZero() { return state; } },
    source: {},
    runtime: { async getTargetStatuses() { targetReads += 1; return []; } },
    audit: {}, sidecars: {},
    privacy: {
      async purgeDerivedHistory() {}, async upsertOperation() {}, async updateOperation() {},
      async hasIncompleteOperation() { return true; }, async listIncompleteOperations() { return []; },
    },
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({ enabled: true, targets: {} }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const result = await runtime.reconcileRebuilds();
  assert.deepEqual(result["1:default"], { status: "skipped", reason: "privacy_delete_pending" });
  assert.equal(targetReads, 0);
  const projections = await runtime.reconcileProjections();
  assert.deepEqual(projections["1:default"], { privacy: { status: "skipped", reason: "privacy_delete_pending" } });
});
