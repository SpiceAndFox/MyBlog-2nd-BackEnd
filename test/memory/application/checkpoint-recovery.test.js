const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");
const { createMemorySourceRebuild } = require("../../../modules/memory/application/sourceRebuild");
const { createMemoryStateRecovery } = require("../../../modules/memory/application/stateRecovery");

const hash = `sha256:${"a".repeat(64)}`;
function snapshot(revision, cursor, sourceGeneration = 2) {
  const state = createInitialMemoryState();
  state.meta = { revision, sourceGeneration, targetCursors: Object.fromEntries(TARGET_KEYS.map(key => [key, cursor])) };
  if (cursor) state.longTerm.relationship.push({ id: "relationship:trust", text: "互相信任",
    createdAtMessageId: cursor, updatedAtMessageId: cursor, sourceRefs: [{ messageId: cursor, contentHash: hash }] });
  return { revision, source_generation: sourceGeneration, schema_version: "2.01", state };
}

function fixture(snapshots, { headRevision = 12, sourceGeneration = 2, messages = [100, 200, 300] } = {}) {
  let authority = { ...snapshot(headRevision, 300, sourceGeneration).state, current: null };
  const statuses = new Map();
  const reads = [];
  const queries = [];
  const anchors = [];
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    sourceWriteGuard: { async lockScope(_u, _p, { client }) { assert.equal(client.transaction, true); } },
    state: {
      async getRawState() { return structuredClone(authority); },
      async getState() { return structuredClone(authority); },
      async writeState(_u, _p, state) { authority = structuredClone(state); },
    },
    source: {
      async getBoundary() { return 300; },
      async getByIds(_u, _p, ids) { return messages.filter(id => ids.includes(id)).map(id => ({ id, contentHash: hash })); },
      async getForceDrainWindow(_u, _p, cursor, boundary) {
        reads.push({ cursor, boundary });
        return messages.filter(id => id > cursor && id <= boundary).map(id => ({ id }));
      },
      async listCompleteTurnBoundaries() { return []; },
    },
    runtime: {
      async cancelNonTerminalTasks(_u, _p, generation) { assert.equal(generation, sourceGeneration + 1); },
      async upsertTargetStatus(_u, _p, row) { statuses.set(row.targetKey, row); },
      async getTargetStatus(_u, _p, key) { return statuses.get(key); },
      async getLibrarianCheckpoint() { return null; },
      async listTasksForTarget() { return []; },
    },
    audit: {
      async getRecoveryHead() { return { revision: headRevision, sourceGeneration }; },
      async listSnapshotsForRecovery(_u, _p, { beforeRevision, limit, sourceGeneration: generation }) {
        queries.push({ beforeRevision, limit, generation });
        return snapshots.filter(row => (beforeRevision == null || row.revision < beforeRevision)
          && row.source_generation === generation).sort((a, b) => b.revision - a.revision).slice(0, limit);
      },
      // Deliberately broken tail: the first required base revision is absent.
      async listRevisionGroups() { return [{ event_group_id: "broken", base_revision: headRevision - 1, result_revision: headRevision }]; },
      async listEventsForGroups() { return []; },
      async insertSnapshot(_u, _p, row) { anchors.push(structuredClone(row)); },
    },
    sidecars: {},
  };
  const rebuild = createMemorySourceRebuild({ repositories,
    normalWritePipeline: {
      async createTask(_u, _p, intent) { return { task: { targetKey: intent.targetKey, baseRevision: authority.meta.revision } }; },
      async processEnvelope() { assert.fail("not used during preparation"); },
      async prepareEnvelope() { return { status: "retry_wait" }; },
      async commitPreparedWave() { assert.fail("pending provider cannot commit"); },
    },
    librarian: { async runAt() {}, async runFinal() {} },
    config: { targets: Object.fromEntries(TARGET_KEYS.map(key => [key, { lagThreshold: 10, contextWindow: 20 }])) },
  });
  const recovery = createMemoryStateRecovery({ repositories, sourceRebuild: rebuild });
  return { recovery, rebuild, statuses, reads, queries, anchors, get state() { return authority; } };
}

test("broken event tail restores a trusted checkpoint and reprocesses only each target's suffix", async () => {
  const anchor = snapshot(10, 200);
  anchor.state.meta.targetCursors.worldFacts = 100;
  const h = fixture([anchor]);
  const prepared = await h.recovery.prepareScopeRecovery(1, "p");
  assert.equal(prepared.status, "rebuild_initialized");
  assert.equal(prepared.restoredFromSnapshotRevision, 10);
  assert.equal(prepared.recoveredFromRaw, false);
  assert.equal(h.state.meta.revision, 13);
  assert.equal(h.state.meta.sourceGeneration, 3);
  assert.deepEqual(h.state.meta.targetCursors, anchor.state.meta.targetCursors);
  assert.deepEqual(h.state.longTerm.relationship, anchor.state.longTerm.relationship);
  assert.equal(h.anchors.length, 1);
  assert.equal([...h.statuses.values()].every(row => row.status === "rebuilding" && row.rebuildBoundaryMessageId === 300), true);
  const result = await h.rebuild.forceDrainTargetsTo(1, "p", { ...prepared, targetKeys: ["worldFacts"], finalizeTargets: false });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(h.reads, [{ cursor: 100, boundary: 300 }]);
});

test("a source-invalid checkpoint falls back to an older safe checkpoint", async () => {
  const newer = snapshot(11, 200);
  newer.state.longTerm.relationship[0].sourceRefs[0].contentHash = `sha256:${"b".repeat(64)}`;
  const h = fixture([snapshot(9, 100), newer]);
  const result = await h.recovery.prepareScopeRecovery(1, "p");
  assert.equal(result.restoredFromSnapshotRevision, 9);
  assert.equal(h.state.meta.targetCursors.scene, 100);
});

test("recovery never resurrects checkpoints from an older source generation", async () => {
  const h = fixture([snapshot(10, 200, 1)]);
  const result = await h.recovery.prepareScopeRecovery(1, "p");
  assert.equal(result.restoredFromSnapshotRevision, null);
  assert.equal(result.recoveredFromRaw, true);
  assert.equal(h.state.longTerm.relationship.length, 0);
  assert.equal(TARGET_KEYS.every(key => (h.state.meta.targetCursors[key] ?? 0) === 0), true);
});

test("recovery searches older pages instead of resetting after a bounded number of bad checkpoints", async () => {
  const bad = Array.from({ length: 40 }, (_, index) => ({ ...snapshot(index + 2, 200), state: { broken: true } }));
  const h = fixture([...bad, snapshot(1, 100)], { headRevision: 42 });
  const result = await h.recovery.prepareScopeRecovery(1, "p");
  assert.equal(result.restoredFromSnapshotRevision, 1);
  assert.equal(h.queries.some(query => query.beforeRevision !== null), true);
  assert.equal(h.queries.every(query => query.limit === 32), true);
});
