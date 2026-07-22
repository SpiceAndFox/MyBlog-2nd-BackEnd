const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createMemorySourceRebuild } = require("../../modules/memory/application/sourceRebuild");
const fs = require("node:fs");
const path = require("node:path");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/source-rebuild.json"), "utf8"));
const item = (id, sourceRefs) => ({ id, text: id, sourceRefs, createdAtMessageId: sourceRefs[0].messageId, updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)) });

function makeRebuildHarness() {
  const state = createInitialMemoryState();
  state.meta.revision = 5;
  state.meta.targetCursors = Object.fromEntries(fixture.targets.map((key) => [key, 9]));
  const data = { state, statuses: {}, snapshots: [], checkpointsMarked: false, cancelled: false, mutationRan: false };
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    state: {
      async getState() { return structuredClone(data.state); },
      async writeState(_u, _p, next) { data.state = structuredClone(next); },
    },
    source: {
      async getBoundary() { return fixture.boundaryMessageId; },
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
  assert.equal(harness.data.cancelled, true);
  assert.equal(harness.data.checkpointsMarked, true);
  assert.equal(harness.data.state.meta.revision, 6);
  assert.deepEqual(harness.data.state.meta.targetCursors, Object.fromEntries(fixture.targets.map((key) => [key, 0])));
  assert.equal(Object.values(harness.data.statuses).every((entry) => entry.status === "rebuilding" && entry.rebuildBoundaryMessageId === 20), true);
  assert.equal(harness.data.snapshots.length, 1);
});

test("force drain ignores lag eligibility and keeps each target rebuilding until boundary validation", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 6;
  state.meta.targetCursors = Object.fromEntries(fixture.targets.map((key) => [key, 0]));
  const statuses = Object.fromEntries(fixture.targets.map((key) => [key, {
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
    async createTask(_u, _p, intent, options) {
      assert.equal(intent.trigger.type, "forceDrain");
      if (intent.targetKey === "scene") assert.match(options.dedupeSuffix, /resume:failed-scene-task$/);
      return { task: { targetKey: intent.targetKey }, options };
    },
    async processEnvelope(envelope) {
      processed.push(envelope.task.targetKey);
      assert.equal(statuses[envelope.task.targetKey].status, "rebuilding");
      const attempt = (attempts.get(envelope.task.targetKey) || 0) + 1;
      attempts.set(envelope.task.targetKey, attempt);
      if (envelope.task.targetKey === "scene" && attempt === 1) return { status: "context_expansion_required" };
      state.meta.targetCursors[envelope.task.targetKey] = 20;
      state.meta.revision += 1;
      snapshots.set(state.meta.revision, { source_generation: 1, schema_version: "2.01", state: structuredClone(state) });
      return { status: "committed" };
    },
  };
  const targets = Object.fromEntries(fixture.targets.map((key) => [key, { lagThreshold: 50, contextWindow: 50 }]));
  const rebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config: { targets } });
  const result = await rebuild.forceDrainTo(7, "companion", { sourceGeneration: 1, boundaryMessageId: 20 });
  assert.equal(result.status, "completed");
  assert.deepEqual(processed, ["scene", ...fixture.targets]);
  assert.equal(Object.values(statuses).every((entry) => entry.status === "healthy" && entry.rebuildBoundaryMessageId === null), true);
});

test("target validation preserves valid rebuilt 2.01 state without suppression storage", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 5;
  state.meta.targetCursors.worldFacts = 10;
  state.longTerm.worldFacts.push(item("old-fact", [fixture.oldSource]));
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
  state.meta.targetCursors = Object.fromEntries(fixture.targets.map((key) => [key, 0]));
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
  const targets = Object.fromEntries(fixture.targets.map((key) => [key, { lagThreshold: 50, contextWindow: 50 }]));
  const rebuild = createMemorySourceRebuild({
    repositories,
    normalWritePipeline: { async createTask() { throw new Error("must reuse retry task"); }, async processEnvelope() { providerCalls += 1; } },
    config: { targets },
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });
  const result = await rebuild.forceDrainTo(7, "companion", { sourceGeneration: 1, boundaryMessageId: 20 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.result.status, "retry_wait");
  assert.equal(result.result.notBefore, future);
  assert.equal(providerCalls, 0);
});
