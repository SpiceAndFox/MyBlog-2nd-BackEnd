const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createMemoryContextAssembly } = require("../../../modules/memory/application/contextAssembly");
const { createMemoryMetrics } = require("../../../modules/memory/application/metrics");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../modules/memory/harness/fixtures/context/gap-bridge-health-recovery.json"), "utf8"));
const TARGETS = ["scene", "todos", "standingAgreements", "episodes", "profileRelationship", "worldFacts"];

function config() {
  return {
    enabled: true,
    gapBridge: fixture.gapBridge,
    scene: { ttlMs: 86_400_000 },
    overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
    sectionBudgets: { recentEpisodes: { maxItems: 20, maxRenderedChars: 2000 } },
  };
}

function makeData() {
  const state = createInitialMemoryState();
  state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 0]));
  const data = { state, diagnostics: [], notifications: [], sourceMessages: fixture.sourceMessages.map((message) => ({
    ...message,
    contentHash: `sha256:${crypto.createHash("sha256").update(message.content).digest("hex")}`,
  })), checkpoints: [
    { projection_key: "rag", processed_generation: 0, processed_boundary_message_id: 5, status: "healthy" },
    { projection_key: "recall", processed_generation: 0, processed_boundary_message_id: 5, status: "healthy" },
  ], nextId: 1 };
  const sidecars = {
    async listActiveDiagnostics() { return data.diagnostics.filter((row) => !row.resolved); },
    async upsertActiveDiagnostic(_user, _preset, diagnostic) {
      let row = data.diagnostics.find((item) => !item.resolved && item.subjectKey === diagnostic.subjectKey && item.diagnosticType === diagnostic.diagnosticType);
      if (row) Object.assign(row, diagnostic);
      else { row = { id: data.nextId++, resolved: false, createdAt: "2026-07-13T00:00:00.000Z", ...diagnostic }; data.diagnostics.push(row); }
      return row;
    },
    async resolveDiagnostic(id) { const row = data.diagnostics.find((item) => item.id === id && !item.resolved); if (row) row.resolved = true; return row || null; },
    async createRecoveryNotification(_user, _preset, notification) {
      const key = `${notification.subjectKind}:${notification.subjectKey}:${notification.sourceGeneration}:${notification.boundaryMessageId}`;
      let row = data.notifications.find((item) => item.key === key);
      if (!row) { row = { id: data.nextId++, key, delivered: false, subjectKind: notification.subjectKind, subjectKey: notification.subjectKey, boundaryMessageId: notification.boundaryMessageId }; data.notifications.push(row); }
      return row;
    },
    async listPendingRecoveryNotifications() { return data.notifications.filter((row) => !row.delivered); },
    async listProjectionCheckpoints() { return data.checkpoints; },
  };
  data.repositories = {
    source: {
      async listUpTo(_userId, _presetId, upToMessageId) {
        return upToMessageId == null ? data.sourceMessages : data.sourceMessages.filter((message) => message.id <= upToMessageId);
      },
      async hasAnyBetween(_userId, _presetId, lowerExclusive, upperInclusive) {
        return data.sourceMessages.some((message) => message.id > lowerExclusive && message.id <= upperInclusive);
      },
    },
    state: { async getRawState() { return data.state; }, async getState() { return data.state; } },
    runtime: { async getTargetStatuses() { return TARGETS.map((targetKey) => ({ targetKey, status: "healthy", sourceGeneration: 0 })); } },
    sidecars,
    async withTransaction(work) { return work({}); },
  };
  return data;
}

test("context assembly persists omitted diagnostics and atomically emits recovery notifications", async () => {
  const data = makeData();
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const degraded = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "request-1", requestNow: "2026-07-13T00:00:05.000Z" });
  assert.equal(degraded.needsMemory, fixture.expected.needsMemory);
  assert.equal(degraded.health.status, fixture.expected.healthBeforeRecovery);
  assert.equal(degraded.health.chatBlocked, false);
  assert.match(degraded.memorySegment, /该类记忆可能滞后/);
  assert.deepEqual(degraded.gapBridge.messages.map((row) => row.id), fixture.expected.retainedGapMessageIds);
  assert.equal(data.diagnostics.filter((row) => !row.resolved).length, 6);

  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  const recovered = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "request-2", requestNow: "2026-07-13T00:00:06.000Z" });
  assert.equal(recovered.health.status, fixture.expected.healthAfterRecovery);
  assert.equal(recovered.notifications.length, 6);
  assert.equal(recovered.notifications[0].message, fixture.expected.notificationMessage);
  assert.equal(data.diagnostics.every((row) => row.resolved), true);
});

test("context assembly keeps valid raw source messages available to GapBridge", async () => {
  const data = makeData();
  const source = data.sourceMessages.find((message) => message.id === 4);
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "raw-context" });
  assert.equal(result.needsMemory, true);
  assert.equal(data.sourceMessages.some((message) => message.id === source.id), true);
});

test("historical context queries cannot falsely resolve a gap diagnostic outside their source slice", async () => {
  const data = makeData();
  data.state.meta.targetCursors.todos = 1;
  data.diagnostics.push({
    id: data.nextId++, subjectKind: "target", subjectKey: "todos", diagnosticType: "gap_bridge_omitted",
    sourceGeneration: 0, targetCursor: 1, omittedUpperMessageId: 3, resolved: false,
  });
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  await assemble({ userId: 1, presetId: "default", upToMessageId: 1, requestId: "historical-query" });
  assert.equal(data.diagnostics[0].resolved, false);
  assert.equal(data.notifications.length, 0);
});

test("projection lag diagnostic persists until the query boundary is covered", async () => {
  const data = makeData();
  const metrics = createMemoryMetrics();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.checkpoints = [{ projection_key: "rag", processed_generation: 0, processed_boundary_message_id: 2 }, { projection_key: "recall", processed_generation: 0, processed_boundary_message_id: 5 }];
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars, metrics });
  const degraded = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "projection-1" });
  assert.equal(degraded.health.status, "degraded");
  assert.equal(data.diagnostics.some((row) => row.subjectKind === "projection" && !row.resolved), true);
  const metricSnapshot = metrics.snapshot();
  assert.equal(metricSnapshot.observations["memory_projection_lag_messages{projectionKey=rag,status=degraded}"].max, 2);
  assert.equal(metricSnapshot.observations["memory_health_state_duration_ms{status=degraded,subjectKey=rag,subjectKind=projection}"].count, 1);

  data.checkpoints[0].processed_boundary_message_id = 4;
  const recovered = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "projection-2" });
  assert.equal(recovered.health.status, "healthy");
  assert.equal(recovered.notifications.some((row) => row.subjectKind === "projection" && row.subjectKey === "rag"), true);
});

test("legacy recall checkpoints never participate in projection health", async () => {
  const data = makeData();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.checkpoints = [
    { projection_key: "rag", processed_generation: 0, processed_boundary_message_id: 5, status: "healthy" },
    { projection_key: "recall", processed_generation: -1, processed_boundary_message_id: 0, status: "rebuilding" },
  ];
  data.diagnostics.push({
    id: data.nextId++, subjectKind: "projection", subjectKey: "recall", diagnosticType: "projection_lag",
    sourceGeneration: 0, recentWindowStart: 5, resolved: false,
  });
  data.notifications.push({
    id: data.nextId++, subjectKind: "projection", subjectKey: "recall", boundaryMessageId: 0,
    sourceGeneration: 0, delivered: false,
  });
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "legacy-recall" });
  assert.equal(result.health.status, "healthy");
  assert.deepEqual(result.projectionCoverage.map((entry) => entry.projectionKey), ["rag"]);
  assert.equal(result.notifications.some((row) => row.subjectKey === "recall"), false);
});

test("scene capacity rejection diagnostic is user-visible until the rejected field later recovers", async () => {
  const data = makeData();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.diagnostics.push({
    id: data.nextId++, subjectKind: "target", subjectKey: "scene", diagnosticType: "scene_capacity_exceeded",
    targetCursor: 3, detail: { rejectedPaths: ["note"] }, resolved: false,
  });
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "scene-capacity" });
  assert.equal(result.health.status, "degraded");
  assert.match(result.health.alerts.find((alert) => alert.subjectKey === "scene").message, /长度超限未写入/);
  assert.match(result.memorySegment, /\[该类记忆可能滞后\]\n\[当前状态\]/);
});

test("effective-view cleanup requests one idempotent housekeeping wake-up", async () => {
  const data = makeData();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.state.working.todos.push({
    id: "todo:due", text: "已到期事项", actor: "user", requester: "user", status: "active", dueAt: "2026-07-12T00:00:00.000Z", becameOverdueAt: null,
    createdAtMessageId: 1, updatedAtMessageId: 1,
    sourceRefs: [{ messageId: 1, contentHash: `sha256:${"a".repeat(64)}` }],
  });
  let wakes = 0;
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars, scheduleHousekeeping() { wakes += 1; } });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestNow: "2026-07-13T00:00:00.000Z" });
  assert.equal(result.housekeepingRequested, true);
  assert.equal(wakes, 1);
  assert.match(result.memorySegment, /已逾期待办/);
});

test("missing or invalid authority state skips only the memory segment with an explicit debug reason", async () => {
  const data = makeData();
  data.state = null;
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const missing = await assemble({ userId: 1, presetId: "default", upToMessageId: 5 });
  assert.equal(missing.memorySegment, "");
  assert.equal(missing.debug.memorySkipReason, "state_missing");
  assert.equal(missing.health.status, "degraded");
  assert.equal(data.diagnostics.some((row) => row.subjectKey === "memory_state" && !row.resolved), true);

  data.state = createInitialMemoryState();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 5]));
  const recovered = await assemble({ userId: 1, presetId: "default", upToMessageId: 5 });
  assert.equal(recovered.notifications.some((row) => row.subjectKind === "system" && row.subjectKey === "memory_state"), true);
});

test("production context initialization can create revision zero before state diagnosis", async () => {
  const data = makeData();
  data.state = null;
  let initialized = 0;
  const assemble = createMemoryContextAssembly({
    repositories: data.repositories,
    config: config(),
    recentWindowMaxChars: fixture.recentWindowMaxChars,
    async ensureState() {
      initialized += 1;
      data.state = createInitialMemoryState();
      data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
    },
  });
  const result = await assemble({ userId: 1, presetId: "new-preset", upToMessageId: 5 });
  assert.equal(initialized, 1);
  assert.match(result.memorySegment, /\[长期核心记忆\]/);
  assert.equal(result.debug.memorySkipReason, null);
  assert.equal(data.diagnostics.some((row) => row.subjectKey === "memory_state" && !row.resolved), false);
});

test("unsupported v2.0 authority is not passed to 2.01 state recovery", async () => {
  const data = makeData();
  data.state = { version: 2, broken: true };
  let recoveries = 0;
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars, scheduleStateRecovery() { recoveries += 1; } });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5 });
  assert.equal(result.memorySegment, "");
  assert.equal(result.debug.memorySkipReason, "version_unsupported");
  assert.equal(recoveries, 0);
});
