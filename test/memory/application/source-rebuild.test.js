const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");
const { createMemorySourceRebuild } = require("../../../modules/memory/application/sourceRebuild");

const REBUILD_BOUNDARY_MESSAGE_ID = 20;
const OLD_SOURCE = { messageId: 10, contentHash: `sha256:${"a".repeat(64)}` };
const item = (id, sourceRefs) => ({ id, text: id, sourceRefs, createdAtMessageId: sourceRefs[0].messageId, updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)) });

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

test("source mutation atomically advances generation, preserves global revision, and enters rebuilding", async () => {
  const harness = makeRebuildHarness();
  const rebuild = createMemorySourceRebuild({ repositories: harness.repositories, normalWritePipeline: harness.normalWritePipeline, config: { targets: {} } });
  const result = await rebuild.initializeGeneration(7, "companion", { mutateSource() { harness.data.mutationRan = true; return "mutated"; } });
  assert.deepEqual(result, { sourceGeneration: 1, revision: 6, boundaryMessageId: 20, mutationResult: "mutated" });
  assert.equal(harness.data.mutationRan, true);
  assert.deepEqual(harness.data.sourceGuardClient, { transaction: true });
  assert.equal(harness.data.cancelled, true);
  assert.equal(harness.data.checkpointsMarked, true);
  assert.equal(harness.data.state.meta.revision, 6);
  assert.deepEqual(harness.data.state.meta.targetCursors, Object.fromEntries(TARGET_KEYS.map((key) => [key, 0])));
  assert.equal(Object.values(harness.data.statuses).every((entry) => entry.status === "rebuilding" && entry.rebuildBoundaryMessageId === 20), true);
  assert.equal(harness.data.snapshots.length, 1);
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

test("force drain ignores lag eligibility and keeps each target rebuilding until boundary validation", async () => {
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
  const result = await rebuild.forceDrainTo(7, "companion", { sourceGeneration: 1, boundaryMessageId: 20 });
  assert.equal(result.status, "completed");
  assert.deepEqual(processed, [...TARGET_KEYS, "scene"]);
  assert.equal(Object.values(statuses).every((entry) => entry.status === "healthy" && entry.rebuildBoundaryMessageId === null), true);
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
