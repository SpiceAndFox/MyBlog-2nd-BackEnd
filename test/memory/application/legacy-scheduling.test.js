const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");
const { buildRebuildLibrarianSchedule } = require("../../../modules/memory/domain/librarianSchedule");
const { createMemorySourceRebuild } = require("../../../modules/memory/application/sourceRebuild");

test("legacy and mixed histories use ordered message counts, including gaps and missing replies", () => {
  for (const metadata of [[false, false, false, false, false], [false, false, true, true, true]]) {
    const messages = [1, 3, 4, 7, 10].map((id, i) => ({ id, hasTurnMetadata: metadata[i] }));
    const schedule = buildRebuildLibrarianSchedule({ messages, turns: [{ boundaryMessageId: 7 }],
      sourceBoundary: 10, lagThreshold: 2, messageBatchSize: 2 });
    assert.equal(schedule.watermarkKind, "message_batch");
    assert.equal(schedule.interval, 1);
    assert.deepEqual(schedule.boundaries, [{ boundaryMessageId: 3 }, { boundaryMessageId: 7 }]);
    assert.deepEqual(buildRebuildLibrarianSchedule({ messages, turns: [{ boundaryMessageId: 7 }],
      sourceBoundary: 10, lagThreshold: 2, messageBatchSize: 2 }), schedule);
  }
});

test("complete-turn histories retain their true turn interval", () => {
  const schedule = buildRebuildLibrarianSchedule({ messages: [1, 3, 4, 7].map(id => ({ id, hasTurnMetadata: true })),
    turns: [{ boundaryMessageId: 3 }, { boundaryMessageId: 7 }], sourceBoundary: 7, lagThreshold: 2, messageBatchSize: 99 });
  assert.equal(schedule.watermarkKind, "complete_turn");
  assert.equal(schedule.interval, 2);
  assert.deepEqual(schedule.boundaries, [{ boundaryMessageId: 3 }, { boundaryMessageId: 7 }]);
});

test("turn-less rebuild resumes frozen boundaries and never repeats completed periodic or final maintenance", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  const ids = [1, 3, 4, 7, 10];
  const checkpoints = new Map();
  const statuses = Object.fromEntries(TARGET_KEYS.map(targetKey => [targetKey, { source_generation: 1, status: "rebuilding", rebuild_boundary_message_id: 10 }]));
  const applied = [];
  let failAtSeven = true;
  let schedulingReads = 0;
  const repositories = {
    async withTransaction(fn) { return fn({}); },
    state: { async getState() { return structuredClone(state); } },
    source: {
      async listSchedulingMessages() { schedulingReads++; return ids.map(id => ({ id, hasTurnMetadata: false })); },
      async listCompleteTurnBoundaries() { return []; },
      async getForceDrainWindow(_u, _p, cursor, boundary) { return ids.filter(id => id > cursor && id <= boundary).map(id => ({ id })); },
    },
    runtime: {
      async getLibrarianCheckpoint(_u, _p, generation) { return structuredClone(checkpoints.get(generation)); },
      async initializeLibrarianRebuildSchedule(_u, _p, generation, schedule) {
        assert.equal(generation, state.meta.sourceGeneration);
        checkpoints.set(generation, { watermarkKind: schedule.watermarkKind, completedOrdinal: 0, boundaryMessageId: 0, rebuildSchedule: structuredClone(schedule) });
        return structuredClone(schedule);
      },
      async getTargetStatus(_u, _p, target) { return statuses[target]; },
      async upsertTargetStatus(_u, _p, value) { statuses[value.targetKey] = { source_generation: value.sourceGeneration, status: value.status, rebuild_boundary_message_id: value.rebuildBoundaryMessageId }; },
    },
    audit: {
      async getSnapshot() { return { revision: 0, source_generation: 1, schema_version: state.version, state: structuredClone(state) }; },
      async listSnapshots() { return [{ revision: 0 }]; },
      async listRevisionGroups() { return []; },
    },
    sidecars: {},
  };
  const normalWritePipeline = {
    async createTask(_u, _p, intent, { messages }) { return { task: { targetKey: intent.targetKey, targetMessageId: messages.at(-1).id, baseRevision: 0 } }; },
    async processEnvelope() { throw new Error("must use wave processing"); },
    async prepareEnvelope(envelope) { return { status: "prepared", envelope }; },
    async commitPreparedWave(entries) {
      for (const { envelope } of entries) state.meta.targetCursors[envelope.task.targetKey] = envelope.task.targetMessageId;
      return { status: "committed" };
    },
  };
  const librarian = {
    async runAt(_u, _p, options) {
      assert.equal(options.watermarkKind, "message_batch");
      assert.ok(TARGET_KEYS.every(key => state.meta.targetCursors[key] === options.boundaryMessageId), "every target must meet the barrier");
      if (options.boundaryMessageId === 7 && failAtSeven) { failAtSeven = false; return { status: "retry_wait" }; }
      applied.push(options.boundaryMessageId);
      Object.assign(checkpoints.get(1), { completedOrdinal: options.watermarkOrdinal, boundaryMessageId: options.boundaryMessageId });
      return { status: "noop" };
    },
    async runFinal(_u, _p, boundary, { schedule }) {
      const checkpoint = checkpoints.get(1);
      assert.equal(schedule.watermarkKind, "message_batch");
      if (checkpoint.boundaryMessageId === boundary) return { status: "completed", deduplicated: true };
      applied.push(`final:${boundary}`);
      Object.assign(checkpoint, { completedOrdinal: schedule.boundaries.length, boundaryMessageId: boundary });
      return { status: "completed" };
    },
  };
  const build = (messageBatchSize) => createMemorySourceRebuild({ repositories, normalWritePipeline, librarian,
    config: { targets: Object.fromEntries(TARGET_KEYS.map(key => [key, { lagThreshold: 10, contextWindow: 10 }])), librarian: { lagThreshold: 2, messageBatchSize } } });
  assert.equal((await build(2).forceDrainTo(1, "test", { sourceGeneration: 1, boundaryMessageId: 10 })).status, "incomplete");
  assert.deepEqual(applied, [3]);
  assert.equal((await build(99).forceDrainTo(1, "test", { sourceGeneration: 1, boundaryMessageId: 10 })).status, "completed");
  assert.deepEqual(applied, [3, 7, "final:10"]);
  assert.equal(schedulingReads, 1, "restart must reuse persisted input even when configuration changes");
  assert.equal((await build(99).forceDrainTo(1, "test", { sourceGeneration: 1, boundaryMessageId: 10 })).status, "completed");
  assert.deepEqual(applied, [3, 7, "final:10"]);
});
