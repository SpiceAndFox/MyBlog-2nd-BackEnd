const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime, createKeyedExecutor } = require("../../../modules/memory/application/runtime");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const {
  createMemoryTestConfig,
  withLibrarianRepositoryStubs,
} = require("../support/memory-builders");

test("disabled v2 runtime never constructs provider or repository dependencies", async () => {
  const runtime = createMemoryRuntime({ config: { enabled: false } });
  assert.equal(runtime.enabled, false);
  assert.deepEqual(await runtime.processScope(1, "default"), { status: "disabled" });
  assert.deepEqual(await runtime.rebuildScope(1, "default"), { status: "disabled" });
});

test("disabled runtime still commits source mutations through the repository transaction", async () => {
  const client = { transaction: true };
  const calls = [];
  const runtime = createMemoryRuntime({
    config: { enabled: false },
    repositories: {
      async withTransaction(work) { return work(client); },
      sourceWriteGuard: {
        async lockScope(userId, presetId, options) {
          calls.push(["guard", userId, presetId, options.client]);
        },
      },
    },
  });
  const result = await runtime.mutateSourceAndRebuild(1, "default", {
    mutateSource(receivedClient) {
      calls.push(["mutation", receivedClient]);
      assert.equal(receivedClient, client);
      return { changed: true };
    },
  });
  assert.deepEqual(result, { status: "memory_disabled", mutationResult: { changed: true } });
  assert.deepEqual(calls, [
    ["guard", 1, "default", client],
    ["mutation", client],
  ]);
});

test("disabled runtime privacy delete purges authority and derived state", async () => {
  const calls = [];
  let operation = null;
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    sourceWriteGuard: {
      async lockScope() { calls.push(["guard"]); },
    },
    privacy: {
      async purgeDerivedHistory() { calls.push(["derived"]); },
      async purgeAuthorityState() { calls.push(["authority"]); },
      async upsertOperation(_u, _p, value) { operation = { ...value }; return operation; },
      async updateOperation(_u, _p, changes) { Object.assign(operation, changes); return operation; },
      async getOperation() { return operation; },
      async listIncompleteOperations() { return []; },
    },
  };
  const runtime = createMemoryRuntime({
    config: { enabled: false }, repositories,
    privacyStores: [{ name: "assistant_gists", async purge() { calls.push(["assistant_gists"]); }, async verifyPurged() { return true; } }],
  });
  const result = await runtime.privacyHardDelete(1, "default", { async deleteRawSource() { calls.push(["raw"]); return 1; } });
  assert.equal(result.status, "purging");
  assert.equal(result.rawMutationCommitted, true);
  assert.deepEqual(calls, [["guard"], ["raw"], ["derived"], ["authority"]]);
  await runtime.shutdown();
  assert.deepEqual(calls, [["guard"], ["raw"], ["derived"], ["authority"], ["assistant_gists"]]);
  assert.equal(operation.status, "completed");
});

test("enabled runtime does not call the Provider until real Memory work exists", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected Provider call");
  };
  const repositories = {
    state: {}, source: {}, runtime: {}, audit: {}, sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  try {
    const runtime = createMemoryRuntime({
      config: createMemoryTestConfig({
        enabled: true,
        provider: { adapter: "openai-json-schema", baseUrl: "https://example.test/v1/", apiKey: "key", model: "preflight-model", timeoutMs: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 8192 },
        targets: {},
      }),
      repositories: withLibrarianRepositoryStubs(repositories),
    });
    assert.equal(runtime.getProviderHealthSnapshot().status, "unknown");
    assert.equal(calls, 0);
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

test("ensureScope initializes revision zero before context assembly", async () => {
  const initial = createInitialMemoryState();
  let state = null;
  let initializations = 0;
  const repositories = {
    state: {
      async getState() { return state; },
      async initializeRevisionZero() {
        initializations += 1;
        state = structuredClone(initial);
        return state;
      },
    },
    source: {},
    runtime: {},
    audit: {},
    sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({ enabled: true, targets: {} }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const ensured = await runtime.ensureScope({ userId: 1, presetId: "new-preset" });
  assert.deepEqual(ensured, initial);
  assert.equal(initializations, 1);
  await runtime.ensureScope({ userId: 1, presetId: "new-preset" });
  assert.equal(initializations, 1);
});

test("manual rebuild requests for one active scope return the same operation identity", async () => {
  const never = new Promise(() => {});
  const repositories = {
    state: { getState: () => never },
    source: {}, runtime: {}, audit: {}, sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({ enabled: true, targets: {}, admission: { concurrency: 1, queueMax: 1 } }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const first = await runtime.rebuildScope(1, "default", { reason: "manual_rebuild" });
  const duplicate = await runtime.rebuildScope(1, "default", { reason: "manual_rebuild" });
  assert.equal(first.status, "queued");
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.operationId, first.operationId);
});
