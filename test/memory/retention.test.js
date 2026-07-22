const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createMemoryRetention } = require("../../modules/memory/application/retention");
const fs = require("node:fs");
const path = require("node:path");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/source-rebuild.json"), "utf8"));

test("retention promotes only a validated continuous anchor and preserves referenced runtime rows", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 2;
  state.meta.revision = 7;
  state.meta.targetCursors.todos = 2;
  const old = "2026-05-01T00:00:00.000Z";
  const recent = "2026-07-12T00:00:00.000Z";
  const revisionFive = structuredClone(state);
  revisionFive.meta.revision = 5;
  revisionFive.meta.targetCursors = {};
  const revisionSix = structuredClone(state);
  revisionSix.meta.revision = 6;
  revisionSix.meta.targetCursors.todos = 1;
  const snapshots = [
    { revision: 5, created_at: old, state: revisionFive },
    { revision: 6, created_at: old, state: revisionSix },
    { revision: 7, created_at: recent, state: structuredClone(state) },
  ];
  const groups = [
    { event_group_id: "g6", user_id: 7, preset_id: "companion", task_id: "task-6", target_key: "todos", source_generation: 2, schema_version: "2.01", base_revision: 5, result_revision: 6, cursor_before: 0, cursor_after: 1, group_kind: "proposal", created_at: old },
    { event_group_id: "g7", user_id: 7, preset_id: "companion", task_id: "task-7", target_key: "todos", source_generation: 2, schema_version: "2.01", base_revision: 6, result_revision: 7, cursor_before: 1, cursor_after: 2, group_kind: "proposal", created_at: recent },
  ];
  let promoted = null;
  let runtimeAnchor = null;
  const calls = [];
  const repositories = {
    async withTransaction(work) { calls.push("retention"); return work({}); },
    state: { async getState() { return structuredClone(state); } },
    audit: {
      async listSnapshots() { return snapshots; },
      async listRevisionGroups() { return groups; },
      async listEventsForGroups() { return []; },
      async promoteAnchor(_u, _p, _g, revision) { promoted = revision; return { snapshotsDeleted: 1, groupsDeleted: 1 }; },
      async deleteExpiredAudit() { return { expiredEvents: 0, expiredGroups: 0, expiredSnapshots: 0 }; },
    },
    runtime: {
      async getTargetStatuses() { return fixture.targets.map((targetKey) => ({ targetKey, sourceGeneration: 2, status: "healthy" })); },
      async deleteRetainedRuntime(_u, _p, options) { runtimeAnchor = options.anchorRevision; return { tasks: 1, ops: 1 }; },
    },
    sidecars: { async listProjectionCheckpoints() { return [{ projectionKey: "rag", processedGeneration: 2, status: "healthy" }]; } },
  };
  const retention = createMemoryRetention({
    repositories,
    config: { retention: { snapshotDays: 30, eventDays: 30, taskDays: 30, opsLogDays: 30 } },
    diagnosticProjection: { async syncScope() { calls.push("diagnostics"); } },
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });
  const result = await retention.runScope(7, "companion");
  assert.deepEqual(calls.slice(0, 2), ["diagnostics", "retention"]);
  assert.equal(result.anchorRevision, 6);
  assert.equal(promoted, 6);
  assert.equal(runtimeAnchor, 6);
});

test("retention rejects an anchor whose state cannot be reproduced from semantic events", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 2;
  state.meta.revision = 7;
  state.meta.targetCursors.todos = 2;
  const anchorFive = structuredClone(state);
  anchorFive.meta.revision = 5;
  anchorFive.meta.targetCursors = {};
  const invalidAnchorSix = structuredClone(state);
  invalidAnchorSix.meta.revision = 6;
  invalidAnchorSix.meta.targetCursors.todos = 2;
  const old = "2026-05-01T00:00:00.000Z";
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getState() { return structuredClone(state); } },
    audit: {
      async listSnapshots() { return [
        { revision: 5, created_at: old, state: anchorFive },
        { revision: 6, created_at: old, state: invalidAnchorSix },
        { revision: 7, created_at: "2026-07-12T00:00:00.000Z", state: structuredClone(state) },
      ]; },
      async listRevisionGroups() { return [
        { event_group_id: "g6", user_id: 7, preset_id: "companion", task_id: "task-6", target_key: "todos", source_generation: 2, schema_version: "2.01", base_revision: 5, result_revision: 6, cursor_before: 0, cursor_after: 1, group_kind: "proposal", created_at: old },
        { event_group_id: "g7", user_id: 7, preset_id: "companion", task_id: "task-7", target_key: "todos", source_generation: 2, schema_version: "2.01", base_revision: 6, result_revision: 7, cursor_before: 1, cursor_after: 2, group_kind: "proposal", created_at: "2026-07-12T00:00:00.000Z" },
      ]; },
      async listEventsForGroups() { return []; },
      async promoteAnchor() { throw new Error("must not promote"); },
    },
    runtime: { async getTargetStatuses() { return []; } },
    sidecars: { async listProjectionCheckpoints() { return []; } },
  };
  const retention = createMemoryRetention({
    repositories,
    config: { retention: { snapshotDays: 30, eventDays: 30, taskDays: 30, opsLogDays: 30 } },
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });
  await assert.rejects(() => retention.runScope(7, "companion"), /does not equal deterministic event replay/);
});
