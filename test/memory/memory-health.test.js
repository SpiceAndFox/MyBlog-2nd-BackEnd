const test = require("node:test");
const assert = require("node:assert/strict");
const { assessProjectionCoverage, aggregateMemoryHealth } = require("../../modules/memory/domain");

const TARGETS = ["scene", "todos", "standingAgreements", "episodes", "profileRelationship", "worldFacts"];

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
  assert.equal(duringDebounce.status, "degraded");
  assert.equal(duringDebounce.alerts.length, 0);
  assert.equal(afterDebounce.status, "degraded");
});

test("diagnostic debounce hides only alert text, not degraded health", () => {
  const statuses = TARGETS.map((targetKey) => ({ targetKey, status: "healthy" }));
  const health = aggregateMemoryHealth({
    targetStatuses: statuses,
    diagnostics: [{
      subjectKind: "target",
      subjectKey: "scene",
      diagnosticType: "scene_capacity_exceeded",
      createdAt: "2026-07-13T00:00:00.000Z",
      resolved: false,
    }],
    now: new Date("2026-07-13T00:00:00.500Z"),
    alertDebounceMs: 1000,
  });
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.alerts, []);
});

test("projection diagnostics apply the same alert debounce as target diagnostics", () => {
  const statuses = TARGETS.map((targetKey) => ({ targetKey, status: "healthy" }));
  const health = aggregateMemoryHealth({
    targetStatuses: statuses,
    diagnostics: [{
      subjectKind: "projection",
      subjectKey: "rag",
      diagnosticType: "projection_lag",
      createdAt: "2026-07-13T00:00:00.000Z",
      resolved: false,
    }],
    projectionHealth: [{ projectionKey: "rag", queryHealth: "degraded", requiredBoundary: 4, processedBoundary: 2 }],
    now: new Date("2026-07-13T00:00:00.500Z"),
    alertDebounceMs: 1000,
  });
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.alerts, []);
});

