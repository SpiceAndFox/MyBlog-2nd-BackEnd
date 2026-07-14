const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { filterRebuiltState, filterRagChunks, filterRecall, reduceProposal } = require("../../modules/memory/domain");
const { createMemorySourceRebuild } = require("../../modules/memory/application/sourceRebuild");
const { createProjectionDrain } = require("../../modules/memory/application/projectionDrain");
const { createPrivacyHardDelete } = require("../../modules/memory/application/privacyHardDelete");
const { createMemoryRetention } = require("../../modules/memory/application/retention");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/stage7-rebuild-suppression.json"), "utf8"));
const ref = (source, quote = "证据") => ({ ...source, quote });
const group = (evidenceKind, source) => ({ evidenceKind, refs: [ref(source)] });
const item = (id, groups) => ({ id, text: id, evidenceGroups: groups, createdAtMessageId: groups[0].refs[0].messageId, updatedAtMessageId: Math.max(...groups.flatMap((entry) => entry.refs.map((entryRef) => entryRef.messageId))) });

test("rebuild terminal suppression removes forgotten candidates but preserves a later correction", () => {
  const state = createInitialMemoryState();
  state.longTerm.userProfile.push(
    item("forgotten", [group("long_term_fact", fixture.oldSource)]),
    item("corrected", [group("long_term_fact", fixture.oldSource), group("user_correction", fixture.correctionSource)]),
  );
  const tombstones = [{ ...fixture.oldSource, reason: "forget" }];
  const filtered = filterRebuiltState(state, tombstones);
  assert.deepEqual(filtered.removedItemIds, ["forgotten"]);
  assert.deepEqual(filtered.state.longTerm.userProfile.map((entry) => entry.id), ["corrected"]);
  state.current.previousScene = { ...structuredClone(state.current.scene), expiredAt: "2026-07-02T00:00:00.000Z" };
  state.current.previousScene.location = { value: "旧地点", evidenceRef: ref(fixture.oldSource), updatedAtMessageId: fixture.oldSource.messageId };
  const sceneFiltered = filterRebuiltState(state, tombstones);
  assert.equal(sceneFiltered.state.current.previousScene.location.value, null);
  assert.equal(sceneFiltered.state.current.previousScene.expiredAt, state.current.previousScene.expiredAt);

  const chunks = filterRagChunks([
    { id: 1, metadata: { sourceRefs: [fixture.oldSource] } },
    { id: 2, metadata: { sourceRefs: [fixture.correctionSource] } },
  ], tombstones);
  assert.deepEqual(chunks.map((entry) => entry.id), [2]);

  const recall = filterRecall({
    evidenceGroups: [group("long_term_fact", fixture.oldSource), group("user_correction", fixture.correctionSource)],
    rawMessages: [{ id: 10, contentHash: fixture.oldSource.contentHash }, { id: 20, contentHash: fixture.correctionSource.contentHash }],
  }, tombstones);
  assert.deepEqual(recall.rawMessages.map((entry) => entry.id), [20]);
  assert.deepEqual(recall.evidenceGroups.map((entry) => entry.evidenceKind), ["user_correction"]);
});

test("Reducer rejects a proposal after the suppression query gate removes its source", () => {
  const state = createInitialMemoryState();
  const message = { id: 10, userId: 7, presetId: "companion", role: "user", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: "2026-07-01T00:00:00.000Z" };
  const sectionBudgets = Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
  const result = reduceProposal({
    state,
    task: { taskId: "task", tickId: 1, userId: 7, presetId: "companion", sourceGeneration: 0, baseRevision: 0, targetKey: "worldFacts", cursorBefore: 0, targetMessageId: 10, proposer: "worldFactProposer", mode: "normal", targetSections: ["worldFacts"], observedMessageIds: [10], now: "2026-07-13T00:00:00.000Z" },
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "addItem", value: { text: "旧事实" }, evidenceKind: "long_term_fact", evidenceRefs: [{ messageId: 10, quote: "旧事实" }] }] } } },
    observedMessages: [{ id: 10, role: "user", contentKind: "raw", content: "旧事实", contentHash: fixture.oldSource.contentHash, createdAt: message.createdAt }],
    databaseMessages: [],
    config: { quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets },
  });
  assert.equal(result.events[0].decision, "rejected");
  assert.equal(result.events[0].rejectReason, "message_id_not_found");
  assert.equal(result.state.longTerm.worldFacts.length, 0);
  assert.equal(result.state.meta.targetCursors.worldFacts, 10);
});

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
      async getSnapshot(_u, _p, revision) { const found = data.snapshots.find((entry) => entry.revision === revision); return found ? { source_generation: found.sourceGeneration, state: found.state } : null; },
    },
    sidecars: {
      async markProjectionsRebuilding() { data.checkpointsMarked = true; },
      async listTombstones() { return []; },
    },
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
  const snapshots = new Map([[6, { source_generation: 1, state: structuredClone(state) }]]);
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
    sidecars: { async listTombstones() { return []; } },
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
      snapshots.set(state.meta.revision, { source_generation: 1, state: structuredClone(state) });
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

test("target validation commits terminal suppression as a replayable cleanup revision", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 1;
  state.meta.revision = 5;
  state.meta.targetCursors.worldFacts = 10;
  state.longTerm.worldFacts.push(item("old-fact", [group("long_term_fact", fixture.oldSource)]));
  const snapshots = new Map([[5, { revision: 5, source_generation: 1, state: structuredClone(state) }]]);
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
      async insertSnapshot(_u, _p, row) { snapshots.set(row.revision, { ...structuredClone(row), source_generation: row.sourceGeneration }); },
    },
    sidecars: { async listTombstones() { return [{ ...fixture.oldSource, reason: "forget" }]; } },
  };
  const rebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: { createTask() {}, processEnvelope() {} }, config: { targets: {} } });
  const result = await rebuild.validateTarget(7, "companion", "worldFacts", 1, 10);
  assert.equal(result.status, "healthy");
  assert.equal(state.longTerm.worldFacts.length, 0);
  assert.equal(state.meta.revision, 6);
  assert.equal(groups[0].group_kind, "system_cleanup");
  assert.equal(events[0].cleanup_type, "suppressed_item_removed");
  assert.equal(snapshots.get(6).state.longTerm.worldFacts.length, 0);
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
      async listTombstones() { return [{ message_id: 10, content_hash: "sha256:old" }]; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const adapter = { async rebuild(args) { calls.push(["rebuild", args]); return { rows: [] }; }, async append() { calls.push(["append"]); return { rows: [] }; }, async suppress(args) { calls.push(["suppress", args]); }, async commit(args) { calls.push(["commit", args]); } };
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
      async listTombstones() { return []; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const failure = Object.assign(new Error("embedding provider failed"), { code: "EMBEDDING_UNAVAILABLE" });
  const adapter = {
    async rebuild() { throw new Error("unexpected rebuild"); },
    async append() { throw failure; },
    async suppress() {},
    async commit() {},
  };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter });
  await assert.rejects(() => drain.drain(7, "companion"), failure);
  assert.deepEqual(checkpointWrite, {
    projectionKey: "rag",
    processedGeneration: 2,
    processedBoundaryMessageId: 10,
    processedTombstoneId: 0,
    status: "degraded",
    lastErrorReason: "EMBEDDING_UNAVAILABLE",
  });
});

test("projection drain consumes new tombstones even when generation and source boundary are unchanged", async () => {
  const state = createInitialMemoryState();
  let checkpointWrite;
  const calls = [];
  const repositories = {
    state: { async getState() { return structuredClone(state); } },
    source: { async getBoundary() { return 20; } },
    sidecars: {
      async getProjectionCheckpoint() { return { processed_generation: 0, processed_boundary_message_id: 20, processed_tombstone_id: 0 }; },
      async listTombstones() { return [{ id: 5, message_id: 10, content_hash: "sha256:old" }]; },
      async upsertProjectionCheckpoint(_u, _p, value) { checkpointWrite = value; },
    },
    async withTransaction(work) { return work({}); },
  };
  const drain = createProjectionDrain({ repositories, projectionKey: "rag", adapter: {
    async rebuild() { throw new Error("unexpected rebuild"); }, async append() { throw new Error("unexpected append"); },
    async suppress(args) { calls.push(args.tombstones[0].id); }, async commit() { throw new Error("unexpected commit"); },
  } });
  const result = await drain.drain(7, "companion");
  assert.equal(result.status, "healthy");
  assert.deepEqual(calls, [5]);
  assert.equal(checkpointWrite.processedTombstoneId, 5);
});

test("privacy hard delete does not force-drain while any external store still reports residue", async () => {
  const calls = [];
  const sourceRebuild = {
    async initializeGeneration(_u, _p, options) { await options.mutateSource({}); await options.purgeDerived({}, { sourceGeneration: 3, boundaryMessageId: 20 }); return { sourceGeneration: 3, boundaryMessageId: 20 }; },
    async forceDrainTo() { calls.push("drain"); return { status: "completed" }; },
  };
  let operation;
  const repositories = {
    async withTransaction(work) { return work({}); },
    privacy: {
      async purgeDerivedHistory() { calls.push("memory-purge"); },
      async upsertOperation(_u, _p, value) { operation = { ...value }; return operation; },
      async updateOperation(_u, _p, value) { Object.assign(operation, value); return operation; },
    },
  };
  const stores = [{ name: "rag", async purge() { calls.push("rag-purge"); }, async verifyPurged() { return false; } }];
  const hardDelete = createPrivacyHardDelete({ repositories, sourceRebuild, stores });
  const result = await hardDelete.execute(7, "companion", { async deleteRawSource() { calls.push("raw-delete"); } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(calls, ["raw-delete", "rag-purge", "memory-purge"]);
  assert.equal(operation.status, "purging");
});

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
    { event_group_id: "g6", user_id: 7, preset_id: "companion", task_id: "task-6", target_key: "todos", source_generation: 2, schema_version: 2, base_revision: 5, result_revision: 6, cursor_before: 0, cursor_after: 1, group_kind: "proposal", created_at: old },
    { event_group_id: "g7", user_id: 7, preset_id: "companion", task_id: "task-7", target_key: "todos", source_generation: 2, schema_version: 2, base_revision: 6, result_revision: 7, cursor_before: 1, cursor_after: 2, group_kind: "proposal", created_at: recent },
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
    sidecars: { async listProjectionCheckpoints() { return ["rag", "recall"].map((projectionKey) => ({ projectionKey, processedGeneration: 2, status: "healthy" })); } },
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
        { event_group_id: "g6", user_id: 7, preset_id: "companion", task_id: "task-6", target_key: "todos", source_generation: 2, schema_version: 2, base_revision: 5, result_revision: 6, cursor_before: 0, cursor_after: 1, group_kind: "proposal", created_at: old },
        { event_group_id: "g7", user_id: 7, preset_id: "companion", task_id: "task-7", target_key: "todos", source_generation: 2, schema_version: 2, base_revision: 6, result_revision: 7, cursor_before: 1, cursor_after: 2, group_kind: "proposal", created_at: "2026-07-12T00:00:00.000Z" },
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
