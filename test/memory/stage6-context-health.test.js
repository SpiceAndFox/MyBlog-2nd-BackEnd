const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { selectRecentWindow, buildGapBridgeCoverage, assessProjectionCoverage, aggregateMemoryHealth } = require("../../modules/memory/domain");
const { createMemoryContextAssembly } = require("../../modules/memory/application/contextAssembly");
const { buildMemorySegment } = require("../../services/chat/context/segments/memory");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/fixtures/context/stage6-context-health.json"), "utf8"));
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
  const data = { state, diagnostics: [], notifications: [], checkpoints: [
    { projection_key: "rag", processed_generation: 0, processed_boundary_message_id: 5, status: "healthy" },
    { projection_key: "recall", processed_generation: 0, processed_boundary_message_id: 5, status: "healthy" },
  ], nextId: 1 };
  const sidecars = {
    async listActiveDiagnostics() { return data.diagnostics.filter((row) => !row.resolved); },
    async upsertActiveDiagnostic(_user, _preset, diagnostic) {
      let row = data.diagnostics.find((item) => !item.resolved && item.subjectKey === diagnostic.subjectKey && item.diagnosticType === diagnostic.diagnosticType);
      if (row) Object.assign(row, diagnostic);
      else { row = { id: data.nextId++, resolved: false, ...diagnostic }; data.diagnostics.push(row); }
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
    source: { async listUpTo() { return fixture.sourceMessages; } },
    state: { async getRawState() { return data.state; } },
    runtime: { async getTargetStatuses() { return TARGETS.map((targetKey) => ({ targetKey, status: "healthy", sourceGeneration: 0 })); } },
    sidecars,
    async withTransaction(work) { return work({}); },
  };
  return data;
}

test("recent window uses Unicode code points, complete messages, and a user boundary", () => {
  const under = selectRecentWindow([{ id: 1, role: "assistant", content: "😀" }, { id: 2, role: "user", content: "好" }], 2);
  assert.equal(under.needsMemory, false);
  assert.equal(under.candidateChars, 2);

  const over = selectRecentWindow([{ id: 1, role: "user", content: "1111" }, { id: 2, role: "assistant", content: "2222" }, { id: 3, role: "assistant", content: "3333" }, { id: 4, role: "user", content: "4444" }], 9);
  assert.equal(over.needsMemory, true);
  assert.deepEqual(over.messages.map((row) => row.id), [4]);
  assert.equal(over.droppedToUserBoundary, 1);

  const oversizedLatest = selectRecentWindow([{ id: 1, role: "user", content: "😀😀😀😀" }], 3);
  assert.equal(oversizedLatest.messages[0].content, "😀😀😀😀");
});

test("GapBridge deduplicates target overlap and never truncates a raw message", () => {
  const state = createInitialMemoryState();
  const result = buildGapBridgeCoverage({ messages: fixture.sourceMessages, state, recentWindowStartMessageId: 5, ...fixture.gapBridge });
  assert.deepEqual(result.messages.map((row) => row.id), fixture.expected.retainedGapMessageIds);
  assert.deepEqual(result.messages[0].targetKeys, TARGETS);
  assert.equal(result.messages[0].content, "第四条");
  assert.equal(result.diagnostics.length, 6);
  assert.equal(result.diagnostics[0].omittedUpperMessageId, fixture.expected.omittedUpperMessageId);
});

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

test("health aggregation gives rebuilding precedence and projection health is query-scoped", () => {
  const health = aggregateMemoryHealth({ targetStatuses: [{ targetKey: "todos", status: "halted" }, { targetKey: "scene", status: "rebuilding" }] });
  assert.equal(health.status, "rebuilding");
  assert.equal(health.chatBlocked, false);
  const haltedAlert = health.alerts.find((row) => row.subjectKey === "todos");
  assert.match(haltedAlert.message, /服务器维护/);
  assert.equal(Object.hasOwn(haltedAlert, "detail"), false, "user health payload must not expose internal status/error details");

  assert.deepEqual(assessProjectionCoverage({ processedGeneration: 0, processedBoundaryMessageId: 8 }, { sourceGeneration: 1, recentWindowStartMessageId: 10 }), { queryHealth: "rebuilding", requiredBoundary: 9, processedBoundary: 8 });
  assert.equal(assessProjectionCoverage({ processedGeneration: 1, processedBoundaryMessageId: 8 }, { sourceGeneration: 1, recentWindowStartMessageId: 10 }).queryHealth, "degraded");
  assert.equal(assessProjectionCoverage({ processedGeneration: 1, processedBoundaryMessageId: 9 }, { sourceGeneration: 1, recentWindowStartMessageId: 10 }).queryHealth, "healthy");
  assert.equal(aggregateMemoryHealth({ targetStatuses: TARGETS.map((targetKey) => targetKey === "todos" ? { target_key: targetKey, status: "halted", rebuild_boundary_message_id: 42 } : { target_key: targetKey, status: "healthy", rebuild_boundary_message_id: null }) }).status, "rebuilding");
});

test("health alert debounce suppresses only newly changed persisted failures", () => {
  const changedAt = "2026-07-13T00:00:00.000Z";
  const statuses = TARGETS.map((targetKey) => targetKey === "todos"
    ? { targetKey, status: "retry_wait", updatedAt: changedAt }
    : { targetKey, status: "healthy", updatedAt: changedAt });
  const duringDebounce = aggregateMemoryHealth({ targetStatuses: statuses, now: new Date("2026-07-13T00:00:00.500Z"), alertDebounceMs: 1000 });
  const afterDebounce = aggregateMemoryHealth({ targetStatuses: statuses, now: new Date("2026-07-13T00:00:01.001Z"), alertDebounceMs: 1000 });
  assert.equal(duringDebounce.status, "healthy");
  assert.equal(afterDebounce.status, "degraded");
});

test("projection lag diagnostic persists until the query boundary is covered", async () => {
  const data = makeData();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.checkpoints = [{ projection_key: "rag", processed_generation: 0, processed_boundary_message_id: 2 }, { projection_key: "recall", processed_generation: 0, processed_boundary_message_id: 5 }];
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars });
  const degraded = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "projection-1" });
  assert.equal(degraded.health.status, "degraded");
  assert.equal(data.diagnostics.some((row) => row.subjectKind === "projection" && !row.resolved), true);

  data.checkpoints[0].processed_boundary_message_id = 4;
  const recovered = await assemble({ userId: 1, presetId: "default", upToMessageId: 5, requestId: "projection-2" });
  assert.equal(recovered.health.status, "healthy");
  assert.equal(recovered.notifications.some((row) => row.subjectKind === "projection" && row.subjectKey === "rag"), true);
});

test("effective-view cleanup requests one idempotent housekeeping wake-up", async () => {
  const data = makeData();
  data.state.meta.targetCursors = Object.fromEntries(TARGETS.map((key) => [key, 3]));
  data.state.working.todos.push({
    id: "todo:due", text: "已到期事项", actor: "user", requester: "user", status: "active", dueAt: "2026-07-12T00:00:00.000Z", becameOverdueAt: null,
    createdAtMessageId: 1, updatedAtMessageId: 1,
    evidenceGroups: [{ evidenceKind: "user_commitment", refs: [{ messageId: 1, contentHash: `sha256:${"a".repeat(64)}`, quote: "第一条" }] }],
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

test("invalid authority schedules background state recovery without blocking context", async () => {
  const data = makeData();
  data.state = { version: 2, broken: true };
  let recoveries = 0;
  const assemble = createMemoryContextAssembly({ repositories: data.repositories, config: config(), recentWindowMaxChars: fixture.recentWindowMaxChars, scheduleStateRecovery() { recoveries += 1; } });
  const result = await assemble({ userId: 1, presetId: "default", upToMessageId: 5 });
  assert.equal(result.memorySegment, "");
  assert.equal(result.debug.memorySkipReason, "state_schema_invalid");
  assert.equal(recoveries, 1);
});

test("v2 memory is emitted as one context segment", () => {
  const segment = buildMemorySegment({ memoryV2: { renderedText: "[长期核心记忆]\n(无)" } });
  assert.equal(segment.messages.length, 1);
  assert.equal(segment.messages[0].role, "system");
  assert.match(segment.messages[0].content, /Memory Control v2/);
});
