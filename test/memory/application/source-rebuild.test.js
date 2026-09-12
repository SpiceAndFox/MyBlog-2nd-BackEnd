const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialMemoryState,
  TARGET_KEYS,
} = require("../../../modules/memory/contracts");
const {
  createMemorySourceRebuild: createProductionMemorySourceRebuild,
} = require("../../../modules/memory/application/sourceRebuild");

const LIBRARIAN_INTERVAL_TURNS = 96;

const REBUILD_BOUNDARY_MESSAGE_ID = 20;
const OLD_SOURCE = { messageId: 10, contentHash: `sha256:${"a".repeat(64)}` };
const item = (id, sourceRefs) => ({ id, text: id, sourceRefs, createdAtMessageId: sourceRefs[0].messageId, updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)) });
const NOOP_LIBRARIAN = Object.freeze({
  async runAt() { return { status: "noop" }; },
  async runFinal() { return { status: "completed", results: [] }; },
});

function createMemorySourceRebuild(options) {
  const repositories = {
    ...options.repositories,
    source: {
      listSchedulingMessages: async () => [],
      ...options.repositories.source,
      listCompleteTurnBoundaries: options.repositories.source.listCompleteTurnBoundaries
        || (async () => []),
    },
    runtime: {
      initializeLibrarianRebuildSchedule: async (_u, _p, _g, schedule) => schedule,
      ...options.repositories.runtime,
      getLibrarianCheckpoint: options.repositories.runtime.getLibrarianCheckpoint
        || (async () => null),
    },
  };
  return createProductionMemorySourceRebuild({
    ...options,
    repositories,
    librarian: options.librarian || NOOP_LIBRARIAN,
    config: {
      librarian: { lagThreshold: LIBRARIAN_INTERVAL_TURNS, messageBatchSize: 192 },
      ...options.config,
    },
  });
}

test("source rebuild fails fast when Librarian dependencies are absent", () => {
  assert.throws(
    () => createProductionMemorySourceRebuild({
      repositories: {
        withTransaction() {},
        state: {},
        source: {},
        runtime: {},
        audit: {},
        sidecars: {},
      },
      normalWritePipeline: { createTask() {}, processEnvelope() {} },
      config: {},
    }),
    /requires the Memory Librarian/,
  );
});

function makeRebuildHarness() {
  const state = createInitialMemoryState();
  state.meta.revision = 5;
  state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 9]));
  const data = { state, statuses: {}, snapshots: [], checkpointsMarked: false, cancelled: false, mutationRan: false, sourceGuardClient: null };
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    sourceWriteGuard: {
      async lockScope(_u, _p, { client }) { data.sourceGuardClient = client; },
    },
    state: {
      async getState() { return structuredClone(data.state); },
      async writeState(_u, _p, next) { data.state = structuredClone(next); },
    },
    source: {
      async getBoundary() { return REBUILD_BOUNDARY_MESSAGE_ID; },
      async getForceDrainWindow() { return []; },
    },
    runtime: {
      async cancelNonTerminalTasks() { data.cancelled = true; },
      async upsertTargetStatus(_u, _p, status) { data.statuses[status.targetKey] = { ...status }; return status; },
      async getTargetStatus(_u, _p, targetKey) { return data.statuses[targetKey]; },
    },
    audit: {
      async insertSnapshot(_u, _p, snapshot) { data.snapshots.push(structuredClone(snapshot)); },
      async getSnapshot(_u, _p, revision) { const found = data.snapshots.find((entry) => entry.revision === revision); return found ? { source_generation: found.sourceGeneration, schema_version: found.schemaVersion, state: found.state } : null; },
    },
    sidecars: { async markProjectionsRebuilding() { data.checkpointsMarked = true; } },
  };
  const normalWritePipeline = { async createTask() { throw new Error("not used"); }, async processEnvelope() { throw new Error("not used"); } };
  return { data, repositories, normalWritePipeline };
}

test("force drain resumes the blocked normal parent when maintenance shares its source window", async () => {
  const h = makeRebuildHarness();
  const generation = h.data.state.meta.sourceGeneration;
  h.data.statuses.todos = { sourceGeneration: generation, status: "retry_wait", rebuildBoundaryMessageId: 20 };
  h.repositories.source.getForceDrainWindow = async () => [{ id: 20 }];
  const parent = { task_id: "parent", task_type: "normal", source_generation: generation,
    cursor_before: 9, target_message_id: 20, status: "running", stage: "capacity_blocked",
    task_payload: { task: { taskId: "parent", targetKey: "todos", baseRevision: 5 } } };
  const child = { ...parent, task_id: "child", task_type: "maintenance", stage: "resumed",
    task_payload: { task: { taskId: "child", targetKey: "todos", baseRevision: 5 } } };
  h.repositories.runtime.listTasksForTarget = async () => [child, parent];
  let resolved = 0;
  const rebuild = createMemorySourceRebuild({ repositories: h.repositories,
    config: { targets: { todos: { lagThreshold: 1, contextWindow: 2 } } },
    normalWritePipeline: { ...h.normalWritePipeline,
      async prepareEnvelope() { assert.fail("must reuse the saved parent proposal"); },
      async commitPreparedWave() { assert.fail("maintenance has not completed"); },
      async cancelPreparedWave() { assert.fail("waiting must retain the parent"); },
      async resolvePreparedWaveCapacity(envelope) {
        assert.equal(envelope.task.taskId, "parent"); resolved++;
        return { status: "retry_wait", taskId: "child", notBefore: "2026-09-11T00:01:00.000Z" };
      },
    } });
  const result = await rebuild.forceDrainTargetsTo(7, "companion", { sourceGeneration: generation,
    boundaryMessageId: 20, targetKeys: ["todos"], finalizeTargets: false });
  assert.equal(result.status, "incomplete");
  assert.equal(result.result.status, "retry_wait");
  assert.equal(resolved, 1);
  assert.equal(h.data.state.meta.targetCursors.todos, 9);
});

test("force drain reloads progress when an old execution commits while preparing the new wave", async () => {
  const h = makeRebuildHarness(); const generation = h.data.state.meta.sourceGeneration;
  for (const key of ["scene", "todos"]) h.data.statuses[key] = { sourceGeneration: generation, status: "rebuilding", rebuildBoundaryMessageId: 20 };
  h.repositories.source.getForceDrainWindow = async () => [{ id: 20 }];
  let reloads = 0; let commits = 0;
  const rebuild = createMemorySourceRebuild({ repositories: h.repositories,
    config: { targets: { scene: { lagThreshold: 1, contextWindow: 2 }, todos: { lagThreshold: 1, contextWindow: 2 } } },
    normalWritePipeline: {
      async createTask(_u, _p, intent) { return { task: { taskId: intent.targetKey, targetKey: intent.targetKey, baseRevision: h.data.state.meta.revision } }; },
      async processEnvelope() { assert.fail("must use wave preparation"); },
      async prepareEnvelope(envelope) {
        if (envelope.task.targetKey === "scene") {
          h.data.state.meta.targetCursors.scene = 20; h.data.state.meta.revision++;
          return { status: "committed", duplicate: true, taskId: "scene" };
        }
        return { status: "prepared", envelope };
      },
      async cancelPreparedWave() { reloads++; },
      async commitPreparedWave(prepared) {
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].envelope.task.baseRevision, h.data.state.meta.revision);
        commits++; h.data.state.meta.targetCursors.todos = 20;
        return { status: "committed", results: [{ status: "committed", taskId: "todos" }] };
      },
    } });
  const result = await rebuild.forceDrainTargetsTo(7, "companion", { sourceGeneration: generation,
    boundaryMessageId: 20, targetKeys: ["scene", "todos"], finalizeTargets: false });
  assert.equal(result.status, "completed");
  assert.equal(reloads, 1);
  assert.equal(commits, 1);
});

test("source mutation atomically advances generation, preserves global revision, and enters rebuilding", async () => {
  const harness = makeRebuildHarness();
  const rebuild = createMemorySourceRebuild({ repositories: harness.repositories, normalWritePipeline: harness.normalWritePipeline, config: { targets: {} } });
  const result = await rebuild.initializeGeneration(7, "companion", { mutateSource() { harness.data.mutationRan = true; return "mutated"; } });
  assert.deepEqual(result, { sourceGeneration: 1, revision: 6, boundaryMessageId: 20, mutationResult: "mutated", rebuildRequired: true });
  assert.equal(harness.data.mutationRan, true);
  assert.deepEqual(harness.data.sourceGuardClient, { transaction: true });
  assert.equal(harness.data.cancelled, true);
  assert.equal(harness.data.checkpointsMarked, true);
  assert.equal(harness.data.state.meta.revision, 6);
  assert.deepEqual(harness.data.state.meta.targetCursors, Object.fromEntries(TARGET_KEYS.map((key) => [key, 0])));
  assert.equal(Object.values(harness.data.statuses).every((entry) => entry.status === "rebuilding" && entry.rebuildBoundaryMessageId === 20), true);
  assert.equal(harness.data.snapshots.length, 1);
});

test("source mutation and derived-history replacement roll back together at every new-generation write boundary", async () => {
  for (const failurePoint of ["purge", "state", "snapshot", "target", "checkpoint", "projection"]) {
    const h = makeRebuildHarness();
    const before = structuredClone(h.data);
    let inject = true;
    const fail = point => {
      if (inject && point === failurePoint) { inject = false; throw new Error(`injected:${point}`); }
    };
    h.repositories.withTransaction = async work => {
      const committed = structuredClone(h.data);
      try { return await work({ transaction: true }); }
      catch (error) {
        for (const key of Object.keys(h.data)) delete h.data[key];
        Object.assign(h.data, committed);
        throw error;
      }
    };
    h.repositories.runtime.getLibrarianCheckpoint = async () => ({
      completed_ordinal: 4, boundary_message_id: 9, watermark_kind: "complete_turn",
    });
    h.repositories.runtime.upsertLibrarianCheckpoint = async (_u, _p, value) => {
      h.data.checkpoint = value;
      fail("checkpoint");
    };
    for (const [repository, method, point] of [
      [h.repositories.state, "writeState", "state"],
      [h.repositories.audit, "insertSnapshot", "snapshot"],
      [h.repositories.runtime, "upsertTargetStatus", "target"],
      [h.repositories.sidecars, "markProjectionsRebuilding", "projection"],
    ]) {
      const original = repository[method];
      repository[method] = async (...args) => { await original(...args); fail(point); };
    }
    const rebuild = createMemorySourceRebuild({ repositories: h.repositories, normalWritePipeline: h.normalWritePipeline, config: { targets: {} } });
    const options = {
      affectedFromMessageId: 30,
      mutateSource(client) { assert.equal(client.transaction, true); h.data.mutationRan = true; return { deleted: 30 }; },
      purgeDerived(client) { assert.equal(client.transaction, true); h.data.historyPurged = true; fail("purge"); },
    };
    await assert.rejects(rebuild.initializeGeneration(7, "companion", options), new RegExp(`injected:${failurePoint}`));
    assert.deepEqual(h.data, before, failurePoint);
    const retried = await rebuild.initializeGeneration(7, "companion", options);
    assert.equal(retried.sourceGeneration, 1);
    assert.equal(retried.revision, 6);
    assert.equal(retried.rebuildRequired, false);
    assert.equal(h.data.snapshots.length, 1);
    assert.equal(h.data.mutationRan, true);
    assert.equal(h.data.historyPurged, true);
  }
});

test("trashing messages after all cursors preserves Memory and its Librarian completion without a model call", async () => {
  const h = makeRebuildHarness();
  h.data.state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map(key => [key, 8278]));
  h.repositories.source.getBoundary = async () => 8278;
  h.repositories.runtime.getLibrarianCheckpoint = async () => ({
    source_generation: 0, completed_ordinal: 54, boundary_message_id: 8278, watermark_kind: "message_batch",
  });
  let carried;
  h.repositories.runtime.upsertLibrarianCheckpoint = async (_u, _p, value) => { carried = value; };
  const before = structuredClone(h.data.state);
  const rebuild = createMemorySourceRebuild({ repositories: h.repositories, normalWritePipeline: h.normalWritePipeline, config: {} });
  const result = await rebuild.mutateAndRebuild(7, "companion", {
    mutateSource: async () => ({ id: 236 }), affectedFromMessageId: () => 8298,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.rebuildRequired, false);
  assert.equal(result.restoredFromSnapshotRevision, 5);
  assert.deepEqual({ ...h.data.state, meta: before.meta }, before);
  assert.deepEqual(carried, { sourceGeneration: 1, boundaryMessageId: 8278, completedOrdinal: 54, watermarkKind: "message_batch", lastTaskId: null });
  assert.equal(Object.values(h.data.statuses).every(row => row.status === "healthy" && row.rebuildBoundaryMessageId === null), true);
});

test("empty and missing sessions leave generation, snapshots and checkpoint unchanged", async () => {
  for (const mutationResult of [{ id: 236 }, null]) {
    const h = makeRebuildHarness();
    const before = structuredClone(h.data.state);
    const rebuild = createMemorySourceRebuild({ repositories: h.repositories, normalWritePipeline: h.normalWritePipeline, config: {} });
    const result = await rebuild.initializeGeneration(7, "companion", {
      mutateSource: async () => mutationResult, affectedFromMessageId: () => null,
    });
    assert.equal(result.rebuildRequired, false);
    assert.deepEqual(h.data.state, before);
    assert.equal(h.data.snapshots.length, 0);
    assert.equal(h.data.cancelled, false);
  }
});

test("permanent purge preserves already-excluded source state but still purges history before its new anchor", async () => {
  const h = makeRebuildHarness();
  const before = structuredClone(h.data.state);
  let purged = false;
  const rebuild = createMemorySourceRebuild({ repositories: h.repositories, normalWritePipeline: h.normalWritePipeline, config: {} });
  const result = await rebuild.initializeGeneration(7, "companion", {
    mutateSource: async () => ({ id: 5 }), affectedFromMessageId: () => 1, sourceAlreadyExcluded: true,
    purgeDerived: async (_client, metadata) => { purged = true; assert.equal(metadata.rebuildRequired, false); },
  });
  assert.equal(purged, true);
  assert.equal(result.rebuildRequired, false);
  assert.deepEqual({ ...h.data.state, meta: before.meta }, before);
  assert.equal(h.data.snapshots.length, 1);
});

test("an unchanged state with unfinished rebuild targets must still finish its existing work", async () => {
  const h = makeRebuildHarness();
  h.repositories.runtime.getTargetStatuses = async () => [{ target_key: "todos", rebuild_boundary_message_id: 20 }];
  const rebuild = createMemorySourceRebuild({ repositories: h.repositories, normalWritePipeline: h.normalWritePipeline, config: {} });
  const result = await rebuild.initializeGeneration(7, "companion", {
    mutateSource: async () => ({ id: 236 }), affectedFromMessageId: () => 21,
  });
  assert.equal(result.rebuildRequired, true);
  assert.equal(result.restoredFromSnapshotRevision, 5);
});

test("source mutation restores the latest unaffected snapshot into the new generation", async () => {
  const current = createInitialMemoryState();
  current.meta.revision = 15;
  current.meta.sourceGeneration = 3;
  current.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 80]));

  const safe = createInitialMemoryState();
  safe.meta.revision = 10;
  safe.meta.sourceGeneration = 3;
  safe.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 40]));
  safe.longTerm.worldFacts.push(item("safe-fact", [OLD_SOURCE]));

  const tooNew = structuredClone(safe);
  tooNew.meta.revision = 14;
  tooNew.meta.targetCursors.scene = 50;
  const snapshots = [
    { revision: 10, source_generation: 3, schema_version: "2.01", state: safe },
    { revision: 14, source_generation: 3, schema_version: "2.01", state: tooNew },
  ];
  const statuses = {};
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    sourceWriteGuard: { async lockScope() {} },
    state: {
      async getState() { return structuredClone(current); },
      async writeState(_u, _p, next) { Object.assign(current, structuredClone(next)); },
    },
    source: {
      async getBoundary() { return 90; },
      async getByIds(_u, _p, ids) {
        return ids.map((id) => ({ id, contentHash: OLD_SOURCE.contentHash }));
      },
    },
    runtime: {
      async cancelNonTerminalTasks() {},
      async upsertTargetStatus(_u, _p, status) { statuses[status.targetKey] = status; },
    },
    audit: {
      async getLatestSnapshotBeforeMessage(_u, _p, options) {
        return snapshots
          .filter((snapshot) => snapshot.revision < options.beforeRevision)
          .filter((snapshot) => TARGET_KEYS.every((key) => (snapshot.state.meta.targetCursors[key] ?? 0) < options.affectedFromMessageId))
          .sort((left, right) => right.revision - left.revision)[0] ?? null;
      },
      async insertSnapshot(_u, _p, snapshot) { snapshots.push(structuredClone(snapshot)); },
    },
    sidecars: {},
  };
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: { async createTask() {}, async processEnvelope() {} },
    config: { targets: {} },
  });

  const result = await rebuild.initializeGeneration(7, "companion", {
    affectedFromMessageId: 50,
    mutateSource: () => "edited",
    purgeDerived: () => { snapshots.length = 0; },
  });

  assert.equal(result.restoredFromSnapshotRevision, 10);
  assert.equal(result.affectedFromMessageId, 50);
  assert.equal(current.meta.revision, 16);
  assert.equal(current.meta.sourceGeneration, 4);
  assert.deepEqual(current.meta.targetCursors, Object.fromEntries(TARGET_KEYS.map((key) => [key, 40])));
  assert.equal(current.longTerm.worldFacts[0].id, "safe-fact");
  assert.equal(Object.values(statuses).every((status) => status.rebuildBoundaryMessageId === 90), true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sourceGeneration, 4);
});

test("snapshot restore rejects stale provenance and safely falls back to an empty rebuild", async () => {
  const current = createInitialMemoryState();
  current.meta.revision = 11;
  current.meta.sourceGeneration = 2;
  current.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 60]));
  const candidate = createInitialMemoryState();
  candidate.meta.revision = 8;
  candidate.meta.sourceGeneration = 2;
  candidate.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 30]));
  candidate.longTerm.worldFacts.push(item("stale-fact", [OLD_SOURCE]));
  let queried = false;
  const repositories = {
    async withTransaction(work) { return work({}); },
    sourceWriteGuard: { async lockScope() {} },
    state: {
      async getState() { return structuredClone(current); },
      async writeState(_u, _p, next) { Object.assign(current, structuredClone(next)); },
    },
    source: {
      async getBoundary() { return 70; },
      async getByIds() { return [{ id: OLD_SOURCE.messageId, contentHash: `sha256:${"b".repeat(64)}` }]; },
    },
    runtime: { async cancelNonTerminalTasks() {}, async upsertTargetStatus() {} },
    audit: {
      async getLatestSnapshotBeforeMessage(_u, _p, { beforeRevision }) {
        if (queried || beforeRevision <= candidate.meta.revision) return null;
        queried = true;
        return { revision: 8, source_generation: 2, schema_version: "2.01", state: structuredClone(candidate) };
      },
      async insertSnapshot() {},
    },
    sidecars: {},
  };
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: { async createTask() {}, async processEnvelope() {} },
    config: { targets: {} },
  });

  const result = await rebuild.initializeGeneration(7, "companion", {
    affectedFromMessageId: 40,
    mutateSource: () => "edited",
  });

  assert.equal(result.restoredFromSnapshotRevision, null);
  assert.equal(current.meta.revision, 12);
  assert.equal(current.meta.sourceGeneration, 3);
  assert.deepEqual(current.meta.targetCursors, Object.fromEntries(TARGET_KEYS.map((key) => [key, 0])));
  assert.deepEqual(current.longTerm.worldFacts, []);
});

test("explicit force-drain resume ignores lag eligibility and keeps each target rebuilding until boundary validation", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 6;
  state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0]));
  const statuses = Object.fromEntries(TARGET_KEYS.map((key) => [key, {
    target_key: key,
    source_generation: 1,
    status: key === "scene" ? "halted" : "rebuilding",
    rebuild_boundary_message_id: key === "scene" ? null : 20,
  }]));
  const snapshots = new Map([[6, { source_generation: 1, schema_version: "2.01", state: structuredClone(state) }]]);
  const processed = [];
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getState() { return structuredClone(state); } },
    source: { async getForceDrainWindow() { return [{ id: 20, role: "user", content: "边界", contentHash: "sha256:boundary", createdAt: "2026-07-13T00:00:00.000Z" }]; } },
    runtime: {
      async getTargetStatus(_u, _p, key) { return statuses[key]; },
      async upsertTargetStatus(_u, _p, value) { statuses[value.targetKey] = { ...value, source_generation: value.sourceGeneration, status: value.status }; },
      async listTasksForTarget(_u, _p, key) {
        if (key !== "scene") return [];
        return [{
          task_id: "failed-scene-task",
          source_generation: 1,
          cursor_before: 0,
          target_message_id: 20,
          status: "failed",
        }];
      },
    },
    audit: {
      async getSnapshot(_u, _p, revision) { return snapshots.get(revision); },
      async listSnapshots() { return [...snapshots].map(([revision, value]) => ({ revision, ...value })); },
      async listRevisionGroups() { return [...snapshots.keys()].filter((revision) => revision > 6).map((revision) => ({ base_revision: revision - 1, result_revision: revision })); },
    },
    sidecars: {},
  };
  const attempts = new Map();
  const pipeline = {
    async processEnvelope() { throw new Error("force drain must use the wave-aware pipeline path"); },
    async createTask(_u, _p, intent, options) {
      assert.equal(intent.trigger.type, "forceDrain");
      if (intent.targetKey === "scene") assert.match(options.dedupeSuffix, /resume:failed-scene-task$/);
      return {
        task: {
          taskId: `task-${intent.targetKey}`,
          targetKey: intent.targetKey,
          cursorBefore: state.meta.targetCursors[intent.targetKey],
          targetMessageId: 20,
          baseRevision: state.meta.revision,
        },
        options,
      };
    },
    async prepareEnvelope(envelope) {
      processed.push(envelope.task.targetKey);
      assert.equal(statuses[envelope.task.targetKey].status, "rebuilding");
      const attempt = (attempts.get(envelope.task.targetKey) || 0) + 1;
      attempts.set(envelope.task.targetKey, attempt);
      if (envelope.task.targetKey === "scene" && attempt === 1) return { status: "context_expansion_required" };
      return { status: "prepared", kind: "proposal", envelope, output: {} };
    },
    async commitPreparedWave(prepared) {
      const committed = [];
      for (const entry of prepared) {
        state.meta.targetCursors[entry.envelope.task.targetKey] = 20;
        state.meta.revision += 1;
        snapshots.set(state.meta.revision, { source_generation: 1, schema_version: "2.01", state: structuredClone(state) });
        committed.push({ status: "committed", targetKey: entry.envelope.task.targetKey });
      }
      return { status: "committed", results: committed };
    },
  };
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 50, contextWindow: 50 }]));
  const rebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config: { targets } });
  const result = await rebuild.forceDrainTo(7, "companion", {
    sourceGeneration: 1,
    boundaryMessageId: 20,
    resumeHalted: true,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(processed, [...TARGET_KEYS, "scene"]);
  assert.equal(Object.values(statuses).every((entry) => entry.status === "healthy" && entry.rebuildBoundaryMessageId === null), true);
});

test("force-drain resume cancels and recreates a stale wave after one target advances the revision", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 11;
  state.meta.targetCursors.scene = 4;
  state.meta.targetCursors.todos = 4;
  state.meta.targetCursors.worldFacts = 8;
  const targetKeys = ["scene", "todos"];
  const statuses = Object.fromEntries(targetKeys.map((targetKey) => [targetKey, {
    target_key: targetKey,
    source_generation: 1,
    status: "rebuilding",
    rebuild_boundary_message_id: 8,
  }]));
  const staleTasks = Object.fromEntries(targetKeys.map((targetKey) => {
    const taskId = `stale-${targetKey}`;
    return [targetKey, {
      task_id: taskId,
      source_generation: 1,
      cursor_before: 4,
      target_message_id: 8,
      status: "running",
      stage: "compiled_proposal_persisted",
      task_payload: {
        task: {
          taskId,
          userId: 7,
          presetId: "companion",
          sourceGeneration: 1,
          targetKey,
          cursorBefore: 4,
          targetMessageId: 8,
          baseRevision: 10,
        },
      },
    }];
  }));
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getState() { return structuredClone(state); } },
    source: {
      async getForceDrainWindow() {
        return [{
          id: 8,
          role: "user",
          content: "新的边界",
          contentHash: "sha256:boundary",
          createdAt: "2026-07-13T00:00:00.000Z",
        }];
      },
    },
    runtime: {
      async getTargetStatus(_u, _p, targetKey) { return statuses[targetKey]; },
      async listTasksForTarget(_u, _p, targetKey) { return [staleTasks[targetKey]]; },
    },
    audit: {},
    sidecars: {},
  };
  const cancelledWaves = [];
  const created = [];
  const committed = [];
  const pipeline = {
    async processEnvelope() { throw new Error("force drain must use the wave-aware pipeline path"); },
    async cancelPreparedWave(envelopes, reason) {
      cancelledWaves.push({
        reason,
        taskIds: envelopes.map((envelope) => envelope.task.taskId),
      });
      for (const envelope of envelopes) staleTasks[envelope.task.targetKey].status = "cancelled";
    },
    async createTask(_u, _p, intent, options) {
      assert.match(options.dedupeSuffix, new RegExp(`resume:stale-${intent.targetKey}$`));
      created.push(intent.targetKey);
      return {
        task: {
          taskId: `rebased-${intent.targetKey}`,
          userId: 7,
          presetId: "companion",
          sourceGeneration: 1,
          targetKey: intent.targetKey,
          cursorBefore: 4,
          targetMessageId: 8,
          baseRevision: state.meta.revision,
        },
      };
    },
    async prepareEnvelope(envelope) {
      return { status: "prepared", kind: "proposal", envelope, output: {} };
    },
    async commitPreparedWave(prepared) {
      assert.deepEqual(prepared.map((entry) => entry.envelope.task.baseRevision), [11, 11]);
      for (const entry of prepared) {
        const targetKey = entry.envelope.task.targetKey;
        state.meta.targetCursors[targetKey] = 8;
        state.meta.revision += 1;
        committed.push(targetKey);
      }
      return {
        status: "committed",
        results: prepared.map((entry) => ({
          status: "committed",
          targetKey: entry.envelope.task.targetKey,
        })),
      };
    },
  };
  const targets = Object.fromEntries(targetKeys.map((targetKey) => [
    targetKey,
    { lagThreshold: 8, contextWindow: 8 },
  ]));
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: pipeline,
    config: { targets },
  });

  const result = await rebuild.forceDrainTargetsTo(7, "companion", {
    sourceGeneration: 1,
    boundaryMessageId: 8,
    targetKeys,
    finalizeTargets: false,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(cancelledWaves, [{
    reason: "wave_baseline_mismatch",
    taskIds: ["stale-scene", "stale-todos"],
  }]);
  assert.deepEqual(created, targetKeys);
  assert.deepEqual(committed, targetKeys);
  assert.equal(state.meta.revision, 13);
  assert.equal(state.meta.targetCursors.worldFacts, 8);
});

test("force drain advances targets by source-watermark waves from one frozen baseline", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  const statuses = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, {
    target_key: targetKey,
    source_generation: 1,
    status: "rebuilding",
    rebuild_boundary_message_id: 8,
  }]));
  const snapshots = new Map([[0, { revision: 0, source_generation: 1, schema_version: "2.01", state: structuredClone(state) }]]);
  const groups = [];
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    role: "user",
    content: `m${index + 1}`,
    contentHash: `sha256:m${index + 1}`,
    createdAt: `2026-07-13T00:00:0${index}.000Z`,
  }));
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getState() { return structuredClone(state); } },
    source: {
      async getForceDrainWindow(_u, _p, cursor, boundary, { newBatchSize }) {
        return messages.filter((message) => message.id > cursor && message.id <= boundary).slice(0, newBatchSize);
      },
    },
    runtime: {
      async getTargetStatus(_u, _p, targetKey) { return statuses[targetKey]; },
      async upsertTargetStatus(_u, _p, value) {
        statuses[value.targetKey] = {
          ...statuses[value.targetKey],
          ...value,
          source_generation: value.sourceGeneration,
          rebuild_boundary_message_id: value.rebuildBoundaryMessageId,
          status: value.status,
        };
      },
      async listTasksForTarget() { return []; },
    },
    audit: {
      async getSnapshot(_u, _p, revision) { return snapshots.get(revision) ?? null; },
      async listSnapshots() { return [...snapshots.values()]; },
      async listRevisionGroups(_u, _p, _g, afterRevision) {
        return groups.filter((group) => group.result_revision > afterRevision);
      },
    },
    sidecars: {},
  };
  const waves = [];
  let activeProviders = 0;
  let maxActiveProviders = 0;
  const pipeline = {
    async processEnvelope() { throw new Error("wave path required"); },
    async createTask(_u, _p, intent, { messages: observed }) {
      return {
        task: {
          taskId: `${intent.targetKey}:${state.meta.targetCursors[intent.targetKey]}:${observed.at(-1).id}`,
          targetKey: intent.targetKey,
          cursorBefore: state.meta.targetCursors[intent.targetKey],
          targetMessageId: observed.at(-1).id,
          baseRevision: state.meta.revision,
        },
      };
    },
    async prepareEnvelope(envelope) {
      activeProviders += 1;
      maxActiveProviders = Math.max(maxActiveProviders, activeProviders);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeProviders -= 1;
      return { status: "prepared", kind: "proposal", envelope, output: {} };
    },
    async commitPreparedWave(prepared) {
      assert.equal(new Set(prepared.map((entry) => entry.envelope.task.baseRevision)).size, 1);
      waves.push(prepared.map((entry) => ({
        targetKey: entry.envelope.task.targetKey,
        targetMessageId: entry.envelope.task.targetMessageId,
        baseRevision: entry.envelope.task.baseRevision,
      })));
      const committed = [];
      for (const entry of prepared.sort((left, right) => (
        TARGET_KEYS.indexOf(left.envelope.task.targetKey) - TARGET_KEYS.indexOf(right.envelope.task.targetKey)
      ))) {
        const baseRevision = state.meta.revision;
        state.meta.targetCursors[entry.envelope.task.targetKey] = entry.envelope.task.targetMessageId;
        state.meta.revision += 1;
        groups.push({ base_revision: baseRevision, result_revision: state.meta.revision });
        snapshots.set(state.meta.revision, {
          revision: state.meta.revision,
          source_generation: 1,
          schema_version: "2.01",
          state: structuredClone(state),
        });
        committed.push({ status: "committed", targetKey: entry.envelope.task.targetKey });
      }
      return { status: "committed", results: committed };
    },
  };
  const targets = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, {
    lagThreshold: targetKey === "scene" ? 2 : targetKey === "todos" ? 4 : 8,
    contextWindow: 8,
  }]));
  const rebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config: { targets } });

  const result = await rebuild.forceDrainTo(1, "default", { sourceGeneration: 1, boundaryMessageId: 8 });

  assert.equal(result.status, "completed");
  assert.deepEqual(waves.map((wave) => wave.map((entry) => `${entry.targetKey}@${entry.targetMessageId}`)), [
    ["scene@2"],
    ["scene@4", "todos@4"],
    ["scene@6"],
    TARGET_KEYS.map((targetKey) => `${targetKey}@8`),
  ]);
  assert.ok(waves.every((wave) => new Set(wave.map((entry) => entry.baseRevision)).size === 1));
  assert.equal(maxActiveProviders, TARGET_KEYS.length);
  assert.equal(Object.values(statuses).every((entry) => entry.status === "healthy"), true);
});

test("rebuild rebases its first Librarian boundary beyond restored target cursors", async () => {
  const completeTurnCount = LIBRARIAN_INTERVAL_TURNS + 4;
  const boundaryMessageId = completeTurnCount * 2;
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, boundaryMessageId]));
  const statuses = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, {
    target_key: targetKey,
    source_generation: 1,
    status: "rebuilding",
    rebuild_boundary_message_id: boundaryMessageId,
  }]));
  const snapshot = {
    revision: 0,
    source_generation: 1,
    schema_version: "2.01",
    state: structuredClone(state),
  };
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getState() { return structuredClone(state); } },
    source: {
      async listSchedulingMessages() { return Array.from({ length: boundaryMessageId }, (_, i) => ({ id: i + 1, hasTurnMetadata: true })); },
      async listCompleteTurnBoundaries() {
        return Array.from({ length: completeTurnCount }, (_, index) => ({
          watermarkOrdinal: index + 1,
          boundaryMessageId: (index + 1) * 2,
        }));
      },
      async getForceDrainWindow() { throw new Error("restored cursors must not drain backwards"); },
    },
    runtime: {
      async getLibrarianCheckpoint() { return null; },
      async getTargetStatus(_u, _p, targetKey) { return statuses[targetKey]; },
      async upsertTargetStatus(_u, _p, value) {
        statuses[value.targetKey] = {
          ...statuses[value.targetKey],
          source_generation: value.sourceGeneration,
          rebuild_boundary_message_id: value.rebuildBoundaryMessageId,
          status: value.status,
        };
      },
    },
    audit: {
      async getSnapshot() { return snapshot; },
      async listSnapshots() { return [snapshot]; },
      async listRevisionGroups() { return []; },
    },
    sidecars: {},
  };
  const calls = [];
  const librarian = {
    async runAt(_u, _p, options) {
      calls.push(options);
      return { status: "noop" };
    },
    async runFinal() { return { status: "completed", results: [] }; },
  };
  const normalWritePipeline = {
    async createTask() { throw new Error("restored cursors require no proposal"); },
    async processEnvelope() { throw new Error("restored cursors require no proposal"); },
    async prepareEnvelope() { throw new Error("restored cursors require no proposal"); },
    async commitPreparedWave() { throw new Error("restored cursors require no proposal"); },
  };
  const targets = Object.fromEntries(TARGET_KEYS.map((targetKey) => [
    targetKey,
    { lagThreshold: 16, contextWindow: 32 },
  ]));
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline,
    librarian,
    config: { targets },
  });

  const result = await rebuild.forceDrainTo(7, "companion", {
    sourceGeneration: 1,
    boundaryMessageId,
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].watermarkOrdinal, completeTurnCount);
  assert.equal(calls[0].boundaryMessageId, boundaryMessageId);
});

test("target validation preserves valid rebuilt 2.01 state without suppression storage", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 5;
  state.meta.targetCursors.worldFacts = 10;
  state.longTerm.worldFacts.push(item("old-fact", [OLD_SOURCE]));
  const snapshots = new Map([[5, { revision: 5, source_generation: 1, schema_version: "2.01", state: structuredClone(state) }]]);
  const groups = [];
  const events = [];
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: {
      async getState() { return structuredClone(state); },
      async writeState(_u, _p, next) { Object.assign(state, structuredClone(next)); },
    },
    source: {},
    runtime: {
      async getTargetStatus() { return { source_generation: 1, rebuild_boundary_message_id: 10, status: "rebuilding", last_task_id: "00000000-0000-0000-0000-000000000010" }; },
      async upsertTargetStatus() {},
    },
    audit: {
      async getSnapshot(_u, _p, revision) { return snapshots.get(revision) || null; },
      async listSnapshots() { return [...snapshots.values()]; },
      async listRevisionGroups(_u, _p, _g, after) { return groups.filter((row) => row.result_revision > after); },
      async insertEventGroup(row) { groups.push(structuredClone(row)); },
      async insertEvents(rows) { events.push(...structuredClone(rows)); },
      async insertSnapshot(_u, _p, row) { snapshots.set(row.revision, { ...structuredClone(row), source_generation: row.sourceGeneration, schema_version: row.schemaVersion }); },
    },
    sidecars: {},
  };
  const rebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: { createTask() {}, processEnvelope() {} }, config: { targets: {} } });
  const result = await rebuild.validateTarget(7, "companion", "worldFacts", 1, 10);
  assert.equal(result.status, "healthy");
  assert.equal(state.longTerm.worldFacts.length, 1);
  assert.equal(state.meta.revision, 5);
  assert.deepEqual(groups, []);
  assert.deepEqual(events, []);
  assert.equal(snapshots.get(5).state.longTerm.worldFacts.length, 1);
});

test("rebuild reconciliation honors a durable retry_wait boundary before invoking the provider", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0]));
  const future = "2026-07-13T00:01:00.000Z";
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getForceDrainWindow() { return [{ id: 20, role: "user", content: "边界" }]; } },
    runtime: {
      async getTargetStatus(_u, _p, targetKey) { return { target_key: targetKey, source_generation: 1, status: "rebuilding", rebuild_boundary_message_id: 20 }; },
      async listTasksForTarget() { return [{
        task_id: "retrying-rebuild-task", source_generation: 1, cursor_before: 0, target_message_id: 20,
        status: "retry_wait", not_before: future, task_payload: { task: { targetKey: "scene" } },
      }]; },
    },
    audit: {}, sidecars: {}, async withTransaction(work) { return work({}); },
  };
  let providerCalls = 0;
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 50, contextWindow: 50 }]));
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: {
      async createTask() { throw new Error("must reuse retry task"); },
      async processEnvelope() { providerCalls += 1; },
      async prepareEnvelope() { providerCalls += 1; },
      async commitPreparedWave() { throw new Error("retry wait must not commit"); },
    },
    config: { targets },
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });
  const result = await rebuild.forceDrainTo(7, "companion", { sourceGeneration: 1, boundaryMessageId: 20 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.result.status, "retry_wait");
  assert.equal(result.result.notBefore, future);
  assert.equal(providerCalls, 0);
});

test("background rebuild reconciliation leaves a halted boundary for explicit manual retry", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0]));
  let providerCalls = 0;
  let statusWrites = 0;
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getForceDrainWindow() { throw new Error("halted rebuild must not read another batch"); } },
    runtime: {
      async getTargetStatus(_u, _p, targetKey) {
        return {
          target_key: targetKey,
          source_generation: 1,
          status: targetKey === "scene" ? "halted" : "rebuilding",
          rebuild_boundary_message_id: 20,
          last_error_reason: targetKey === "scene" ? "llm_call_failed" : null,
        };
      },
      async upsertTargetStatus() { statusWrites += 1; },
      async listTasksForTarget() { return []; },
    },
    audit: {},
    sidecars: {},
    async withTransaction(work) { return work({}); },
  };
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 50, contextWindow: 50 }]));
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: {
      async createTask() { providerCalls += 1; },
      async processEnvelope() { providerCalls += 1; },
      async prepareEnvelope() { providerCalls += 1; },
      async commitPreparedWave() { providerCalls += 1; },
    },
    config: { targets },
  });

  const result = await rebuild.forceDrainTo(7, "companion", {
    sourceGeneration: 1,
    boundaryMessageId: 20,
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.result.status, "halted");
  assert.equal(result.result.reason, "llm_call_failed");
  assert.equal(providerCalls, 0);
  assert.equal(statusWrites, 0);
});
