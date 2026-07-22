const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createProjectionDrain } = require("../../modules/memory/application/projectionDrain");

test("projection drain rebuilds on generation mismatch and rejects a stale completion", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 2;
  let boundary = 20;
  let checkpointWrite = null;
  const calls = [];
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getBoundary() { return boundary; } },
    sidecars: {
      async getProjectionCheckpoint() { return { processed_generation: 1, processed_boundary_message_id: 10 }; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const adapter = { async rebuild(args) { calls.push(["rebuild", args]); return { rows: [] }; }, async append() { calls.push(["append"]); return { rows: [] }; }, async commit(args) { calls.push(["commit", args]); } };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter });
  const healthy = await drain.drain(7, "companion");
  assert.equal(healthy.status, "healthy");
  assert.deepEqual(calls.map((entry) => entry[0]), ["rebuild", "commit"]);
  assert.equal(checkpointWrite.processedGeneration, 2);

  checkpointWrite = null;
  adapter.rebuild = async () => { boundary = 21; return { rows: [] }; };
  const stale = await drain.drain(7, "companion");
  assert.equal(stale.status, "stale");
  assert.equal(checkpointWrite, null);
});

test("projection drain persists a retryable coverage state when staging fails", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 2;
  let checkpointWrite = null;
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getBoundary() { return 20; } },
    sidecars: {
      async getProjectionCheckpoint() { return { processed_generation: 2, processed_boundary_message_id: 10 }; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const failure = Object.assign(new Error("embedding provider failed"), { code: "EMBEDDING_UNAVAILABLE" });
  const adapter = {
    async rebuild() { throw new Error("unexpected rebuild"); },
    async append() { throw failure; },
    async commit() {},
  };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter });
  await assert.rejects(() => drain.drain(7, "companion"), failure);
  assert.deepEqual(checkpointWrite, {
    projectionKey: "rag",
    processedGeneration: 2,
    processedBoundaryMessageId: 10,
    status: "degraded",
    lastErrorReason: "EMBEDDING_UNAVAILABLE",
  });
});

test("projection drain uses only generation and source boundary when already current", async () => {
  const state = createInitialMemoryState();
  let checkpointWrite;
  const calls = [];
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getBoundary() { return 20; } },
    sidecars: {
      async getProjectionCheckpoint() { return { processed_generation: 0, processed_boundary_message_id: 20 }; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter: {
    async rebuild() { throw new Error("unexpected rebuild"); }, async append() { throw new Error("unexpected append"); },
    async commit() { throw new Error("unexpected commit"); },
  } });
  const result = await drain.drain(7, "companion");
  assert.equal(result.status, "healthy");
  assert.deepEqual(calls, []);
  assert.deepEqual(checkpointWrite, { projectionKey: "rag", processedGeneration: 0, processedBoundaryMessageId: 20, status: "healthy", lastErrorReason: null });
});
