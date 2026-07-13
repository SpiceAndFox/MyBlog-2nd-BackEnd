const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime, createKeyedExecutor } = require("../../modules/memory/application/runtime");
const { createInitialMemoryState, TARGET_KEYS } = require("../../modules/memory/contracts");

test("disabled v2 runtime never constructs provider or repository dependencies", async () => {
  const runtime = createMemoryRuntime({ config: { enabled: false } });
  assert.equal(runtime.enabled, false);
  assert.deepEqual(await runtime.processScope(1, "default"), { status: "disabled" });
  assert.deepEqual(await runtime.rebuildScope(1, "default"), { status: "disabled" });
});

test("disabled runtime still commits source mutations through the repository transaction", async () => {
  const client = { transaction: true };
  const runtime = createMemoryRuntime({
    config: { enabled: false },
    repositories: { async withTransaction(work) { return work(client); } },
  });
  const result = await runtime.mutateSourceAndRebuild(1, "default", {
    mutateSource(receivedClient) {
      assert.equal(receivedClient, client);
      return { changed: true };
    },
  });
  assert.deepEqual(result, { status: "memory_disabled", mutationResult: { changed: true } });
});

test("default runtime performs one complete Provider preflight before becoming ready", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    const userPayload = JSON.parse(request.messages[1].content);
    return {
      ok: true,
      async json() {
        return { model: "preflight-model", choices: [{ finish_reason: "stop", message: { parsed: userPayload.expectedOutput } }] };
      },
    };
  };
  const repositories = {
    state: {}, source: {}, runtime: {}, audit: {}, sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  try {
    const runtime = createMemoryRuntime({
      config: {
        enabled: true,
        provider: { adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "preflight-model", timeoutMs: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 8192 },
        targets: {}, providerRecovery: {}, compaction: {},
      },
      repositories,
    });
    const first = await runtime.initialize();
    const second = await runtime.initialize();
    assert.equal(first.length, 7);
    assert.deepEqual(second, first);
    assert.equal(calls, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v2 runtime executor serializes one scope without blocking another", async () => {
  const enqueue = createKeyedExecutor();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = enqueue("1:default", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = enqueue("1:default", async () => { events.push("second"); });
  const other = enqueue("2:default", async () => { events.push("other"); });

  await other;
  assert.deepEqual(events, ["first:start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "other", "first:end", "second"]);
});

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
  const projectionDrains = Object.fromEntries(["rag", "recall"].map((key) => [key, {
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
  assert.deepEqual(projectionCalls, [["rag", 1, "default"], ["recall", 1, "default"]]);
  const stop = runtime.startProjectionPolling();
  assert.equal(typeof stop, "function");
  assert.equal(runtime.startProjectionPolling(), runtime.stopProjectionPolling);
  stop();
});

test("one projection failure does not starve the other projection during reconciliation", async () => {
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
      recall: { async drain() { return { status: "healthy" }; } },
    },
    onBackgroundError(error) { errors.push(error.code); },
  });

  const results = await runtime.reconcileProjections();
  assert.deepEqual(results["1:default"], {
    diagnostics: { status: "failed", reason: "DIAGNOSTICS_FAILED" },
    rag: { status: "failed", reason: "RAG_FAILED" },
    recall: { status: "healthy" },
  });
  assert.deepEqual(errors, ["DIAGNOSTICS_FAILED", "RAG_FAILED"]);
});

test("durable task polling continuously scans queued and due retry tasks", async () => {
  let scans = 0;
  const state = createInitialMemoryState();
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const repositories = {
    state: { async getState() { return state; }, async initializeRevisionZero() { return state; } },
    source: { async countAfter() { return 0; } },
    runtime: { async getTargetStatuses() { return []; }, async listRecoverableTasks() { scans += 1; return []; } },
    audit: {}, sidecars: {}, async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: { enabled: true, targets, tasks: { pollIntervalMs: 250 }, projections: { pollIntervalMs: 1000 }, providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 }, compaction: { retryMax: 1 } },
    repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const stop = runtime.startTaskPolling();
  await new Promise((resolve) => setTimeout(resolve, 320));
  stop();
  assert.ok(scans >= 1);
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
