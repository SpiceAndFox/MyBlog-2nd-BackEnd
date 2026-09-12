const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createProjectionDrain } = require("../../../modules/memory/application/projectionDrain");

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
  const appended = await drain.drain(7, "companion");
  assert.equal(appended.status, "healthy");
  assert.equal(checkpointWrite.processedBoundaryMessageId, 20);

  checkpointWrite = null;
  adapter.rebuild = async () => { state.meta.sourceGeneration += 1; return { rows: [] }; };
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

test("cancelled projection staging never promotes a late embedding result or writes failure health", { timeout: 2000 }, async () => {
  const state = createInitialMemoryState();
  const staged = Promise.withResolvers();
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const writes = [];
  const drain = createProjectionDrain({ projectionKey: "rag", repositories: {
    state: { async getState() { return state; } },
    source: { async getBoundary() { return 20; } },
    sidecars: {
      async getProjectionCheckpoint() { return { processed_generation: 0, processed_boundary_message_id: 10 }; },
      async upsertProjectionCheckpoint() { writes.push("checkpoint"); },
    },
    async withTransaction(work) { return work({}); },
  }, adapter: {
    async rebuild() { throw new Error("unexpected rebuild"); },
    append({ signal }) { assert.equal(signal, controller.signal); started.resolve(); return staged.promise; },
    async commit() { writes.push("commit"); },
  } });
  const work = drain.drain(1, "default", { signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal((await work).status, "interrupted");
  staged.resolve({ chunks: ["old-source"] });
  await new Promise(setImmediate);
  assert.deepEqual(writes, []);
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

test("resumable RAG rebuild persists every staged batch and resumes after a failed batch", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 2;
  let checkpoint = {
    processed_generation: 1,
    processed_boundary_message_id: 0,
    status: "rebuilding",
  };
  let failSecondBatch = true;
  let finalized = 0;
  const requestedAfter = [];
  const stagedBoundaries = [];
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getBoundary() { return 6; } },
    sidecars: {
      async getProjectionCheckpoint() { return checkpoint; },
      async upsertProjectionCheckpoint(_u, _p, value) {
        checkpoint = {
          processed_generation: value.processedGeneration,
          processed_boundary_message_id: value.processedBoundaryMessageId,
          status: value.status,
          last_error_reason: value.lastErrorReason,
        };
      },
    },
    async withTransaction(work) { return work({ transaction: true }); },
  };
  const adapter = {
    async rebuildBatch({ afterMessageId }) {
      requestedAfter.push(afterMessageId);
      if (afterMessageId === 0) {
        return { chunks: [{ id: "first" }], processedBoundaryMessageId: 2, complete: false };
      }
      if (failSecondBatch) {
        failSecondBatch = false;
        throw Object.assign(new Error("embedding offline"), { code: "EMBEDDING_UNAVAILABLE" });
      }
      return { chunks: [{ id: "second" }], processedBoundaryMessageId: 6, complete: true };
    },
    async stageRebuildBatch({ staged }) {
      stagedBoundaries.push(staged.processedBoundaryMessageId);
    },
    async finalizeRebuild() { finalized += 1; },
    async rebuild() { throw new Error("legacy rebuild should not run"); },
    async append() { throw new Error("append should not run"); },
    async commit() { throw new Error("legacy commit should not run"); },
  };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter });

  await assert.rejects(() => drain.drain(1, "default"), /embedding offline/);
  assert.equal(checkpoint.processed_generation, 2);
  assert.equal(checkpoint.processed_boundary_message_id, 2);
  assert.equal(checkpoint.status, "rebuilding");

  const result = await drain.drain(1, "default");
  assert.equal(result.status, "healthy");
  assert.deepEqual(requestedAfter, [0, 2, 2]);
  assert.deepEqual(stagedBoundaries, [2, 6]);
  assert.equal(finalized, 1);
});
