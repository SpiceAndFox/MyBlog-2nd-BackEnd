const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime } = require("../../modules/memory/application/runtime");
const { createInitialMemoryState, TARGET_KEYS } = require("../../modules/memory/contracts");

test("startup recovery reconciles projections for initialized scopes using the public repository method", async () => {
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
    sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  const projectionDrains = Object.fromEntries(["rag"].map((key) => [key, {
    async drain(userId, presetId) {
      projectionCalls.push([key, userId, presetId]);
      return { status: "healthy" };
    },
  }]));
  const runtime = createMemoryRuntime({
    config: {
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
      providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 },
      compaction: { retryMax: 1 },
    },
    repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
    projectionDrains,
  });

  assert.deepEqual(await runtime.recoverPending(), []);
  assert.deepEqual(projectionCalls, [["rag", 1, "default"]]);
  const stop = runtime.startProjectionPolling();
  assert.equal(typeof stop, "function");
  assert.equal(runtime.startProjectionPolling(), runtime.stopProjectionPolling);
  stop();
});

test("diagnostic projection failure does not starve the RAG projection during reconciliation", async () => {
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
    config: {
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
      providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 },
      compaction: { retryMax: 1 },
    },
    repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
    projectionDrains: {
      rag: { async drain() { throw Object.assign(new Error("rag failed"), { code: "RAG_FAILED" }); } },
    },
    onBackgroundError(error) { errors.push(error.code); },
  });

  const results = await runtime.reconcileProjections();
  assert.deepEqual(results["1:default"], {
    diagnostics: { status: "failed", reason: "DIAGNOSTICS_FAILED" },
    rag: { status: "failed", reason: "RAG_FAILED" },
  });
  assert.deepEqual(errors, ["DIAGNOSTICS_FAILED", "RAG_FAILED"]);
});

test("runtime rejects the retired recall projection drain", () => {
  const state = createInitialMemoryState();
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  assert.throws(() => createMemoryRuntime({
    config: {
      enabled: true,
      targets,
      projections: { pollIntervalMs: 1000 },
      providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 },
      compaction: { retryMax: 1 },
    },
    repositories: {
      state: { async getState() { return state; } },
      source: {},
      runtime: {},
    },
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
    projectionDrains: { recall: { async drain() {} } },
  }), /Unsupported Memory projection drain: recall/);
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
      async getSnapshot() { return { source_generation: 0, state: structuredClone(state) }; },
      async listSnapshots() { return [{ revision: 0, source_generation: 0, state: structuredClone(state) }]; },
      async listRevisionGroups() { return []; },
    },
    sidecars: { async listTombstones() { return []; }, async listProjectionCheckpoints() { return []; } },
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({ config: { enabled: true, targets, projections: { pollIntervalMs: 1000 }, providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 }, compaction: { retryMax: 1 } }, repositories, providerAdapter: { async propose() { throw new Error("no provider call expected"); } } });
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
    config: { enabled: true, targets: {}, providerRecovery: {}, compaction: {} }, repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const result = await runtime.reconcileRebuilds();
  assert.deepEqual(result["1:default"], { status: "skipped", reason: "privacy_delete_pending" });
  assert.equal(targetReads, 0);
  const projections = await runtime.reconcileProjections();
  assert.deepEqual(projections["1:default"], { privacy: { status: "skipped", reason: "privacy_delete_pending" } });
});
