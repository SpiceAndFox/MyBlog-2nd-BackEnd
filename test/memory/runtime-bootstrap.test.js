const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime, createKeyedExecutor } = require("../../modules/memory/application/runtime");
const { createInitialMemoryState } = require("../../modules/memory/contracts");

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

test("disabled runtime privacy delete purges legacy v2 authority and derived state", async () => {
  const calls = [];
  let operation = null;
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    privacy: {
      async purgeDerivedHistory(_u, _p, options) { calls.push(["derived", options.preserveTombstones]); },
      async purgeAuthorityState() { calls.push(["authority"]); },
      async upsertOperation(_u, _p, value) { operation = { ...value }; return operation; },
      async updateOperation(_u, _p, changes) { Object.assign(operation, changes); return operation; },
      async getOperation() { return operation; },
      async listIncompleteOperations() { return []; },
    },
  };
  const runtime = createMemoryRuntime({
    config: { enabled: false }, repositories,
    privacyStores: [{ name: "rag", async purge() { calls.push(["rag"]); }, async verifyPurged() { return true; } }],
  });
  const result = await runtime.privacyHardDelete(1, "default", { async deleteRawSource() { calls.push(["raw"]); return 1; } });
  assert.equal(result.status, "purging");
  assert.equal(result.rawMutationCommitted, true);
  assert.deepEqual(calls, [["raw"], ["derived", true], ["authority"]]);
  await runtime.shutdown();
  assert.deepEqual(calls, [["raw"], ["derived", true], ["authority"], ["rag"]]);
  assert.equal(operation.status, "completed");
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
    config: { enabled: true, targets: {}, providerRecovery: {}, compaction: {} },
    repositories,
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
    config: { enabled: true, targets: {}, providerRecovery: {}, compaction: {}, admission: { concurrency: 1, queueMax: 1 } },
    repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const first = await runtime.rebuildScope(1, "default", { reason: "manual_rebuild" });
  const duplicate = await runtime.rebuildScope(1, "default", { reason: "manual_rebuild" });
  assert.equal(first.status, "queued");
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.operationId, first.operationId);
});
