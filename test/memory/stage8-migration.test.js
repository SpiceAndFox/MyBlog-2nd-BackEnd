const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialMemoryState, TARGET_KEYS, SCHEMA_VERSION } = require("../../modules/memory/contracts");
const { createMemoryMigration } = require("../../modules/memory/application/migration");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures/stage8-migration.json"), "utf8"));

function makeHarness({ projectionFailure = null, verificationFailure = null, forceDrainFailureOnce = false } = {}) {
  let state = null;
  let snapshots = [];
  let statuses = [];
  let checkpoints = [];
  let clock = 0;
  let initializeCount = 0;
  let forceDrainCount = 0;
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    state: {
      async getState() { return state ? structuredClone(state) : null; },
      async initializeRevisionZero() { state = createInitialMemoryState(); return structuredClone(state); },
    },
    source: {
      async getHistoryMetrics() { return { ...fixture.history }; },
      async getBoundary() { return fixture.history.boundaryMessageId + (verificationFailure === "boundary" ? 1 : 0); },
    },
    runtime: { async getTargetStatuses() { return structuredClone(statuses); } },
    audit: {
      async getSnapshot(_u, _p, revision) { return structuredClone(snapshots.find((entry) => entry.revision === revision) || null); },
      async listSnapshots() { return structuredClone(snapshots); },
      async listRevisionGroups() {
        if (verificationFailure !== "eventChain") return [];
        return [{ base_revision: fixture.revision, result_revision: fixture.revision + 2 }];
      },
    },
    sidecars: { async listProjectionCheckpoints() { return structuredClone(checkpoints); } },
    migration: {
      async listSourceScopes() { return [fixture.scope]; },
    },
  };
  const sourceRebuild = {
    async initializeGeneration() {
      initializeCount += 1;
      state.meta.sourceGeneration = fixture.sourceGeneration;
      state.meta.revision = fixture.revision;
      snapshots = [{ source_generation: fixture.sourceGeneration, revision: fixture.revision, schema_version: SCHEMA_VERSION, state: structuredClone(state) }];
      statuses = TARGET_KEYS.map((targetKey) => ({
        target_key: targetKey,
        source_generation: fixture.sourceGeneration,
        rebuild_boundary_message_id: fixture.history.boundaryMessageId,
        status: "rebuilding",
      }));
      return { sourceGeneration: fixture.sourceGeneration, revision: fixture.revision, boundaryMessageId: fixture.history.boundaryMessageId };
    },
    async forceDrainTo() {
      forceDrainCount += 1;
      if (forceDrainFailureOnce && forceDrainCount === 1) {
        statuses = statuses.map((status) => status.target_key === "scene"
          ? { ...status, status: "halted", rebuild_boundary_message_id: null }
          : status);
        return {
          status: "incomplete",
          sourceGeneration: fixture.sourceGeneration,
          targetKey: "scene",
          result: { status: "queued", outcome: "transaction_failed", taskId: "task-1" },
          results: [{ status: "queued" }],
        };
      }
      state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, fixture.history.boundaryMessageId]));
      state.current.scene.location = {
        value: "上海😊",
        evidenceRef: { messageId: fixture.history.boundaryMessageId, contentHash: `sha256:${"a".repeat(64)}`, quote: "上海😊" },
        updatedAtMessageId: fixture.history.boundaryMessageId,
      };
      snapshots[0].state = structuredClone(state);
      statuses = TARGET_KEYS.map((targetKey) => ({ target_key: targetKey, source_generation: fixture.sourceGeneration, status: "healthy" }));
      if (verificationFailure === "target") statuses[0].status = "halted";
      if (verificationFailure === "snapshot") snapshots[0].state.current.scene.location = createInitialMemoryState().current.scene.location;
      return { status: "completed" };
    },
  };
  const projectionDrains = Object.fromEntries(["rag", "recall"].map((projectionKey) => [projectionKey, {
    async drain() {
      if (projectionFailure === projectionKey) return { status: "stale" };
      checkpoints.push({
        projection_key: projectionKey,
        processed_generation: fixture.sourceGeneration,
        processed_boundary_message_id: fixture.history.boundaryMessageId - (verificationFailure === "checkpoint" ? 1 : 0),
        status: "healthy",
      });
      return { status: "healthy" };
    },
  }]));
  const migration = createMemoryMigration({ repositories, sourceRebuild, projectionDrains, now: () => new Date("2026-07-13T00:00:00.000Z"), monotonicNow: () => (clock += 5) });
  return { migration, getInitializeCount: () => initializeCount };
}

test("stage 8 rehearsal rebuilds every raw-history scope", async () => {
  const harness = makeHarness();
  const report = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(report.status, "completed");
  assert.equal(report.canStartService, false);
  assert.equal(report.scopeCount, 1);
  assert.equal(report.results[0].messageCount, fixture.history.messageCount);
  assert.equal(report.results[0].characterCount, fixture.history.characterCount);
  assert.equal(report.results[0].boundaryMessageId, fixture.history.boundaryMessageId);
  assert.deepEqual(report.results[0].sectionUsage.scene, { itemCount: 1, textChars: 3 });
  assert.deepEqual(report.results[0].sectionUsage.todos, { itemCount: 0, textChars: 0 });
  assert.equal(report.results[0].durationMs > 0, true);
});

test("stage 8 rehearsal is repeatable and never opens the service start gate", async () => {
  const harness = makeHarness();
  const first = await harness.migration.run({ mode: "rehearsal" });
  const second = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.canStartService, false);
});

test("stage 8 resumes an incomplete force drain without resetting its generation", async () => {
  const harness = makeHarness({ forceDrainFailureOnce: true });
  const first = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(first.status, "failed");
  assert.deepEqual(first.error.detail, {
    sourceGeneration: fixture.sourceGeneration,
    targetKey: "scene",
    result: { status: "queued", outcome: "transaction_failed", reason: null, taskId: "task-1" },
    completedTaskCount: 1,
  });
  const second = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(second.status, "completed");
  assert.equal(second.canStartService, true);
  assert.equal(harness.getInitializeCount(), 1);
});

test("stage 8 cutover requires an explicitly stopped service", async () => {
  const harness = makeHarness();
  await assert.rejects(() => harness.migration.run({ mode: "cutover" }), /serviceStopped=true/);
});

test("stage 8 cutover opens the start gate only after full verification", async () => {
  const harness = makeHarness();
  const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(report.status, "completed");
  assert.equal(report.canStartService, true);
});

test("a stale projection keeps the service start gate closed", async () => {
  const harness = makeHarness({ projectionFailure: "recall" });
  const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(report.status, "failed");
  assert.equal(report.canStartService, false);
  assert.match(report.error.message, /Projection recall drain did not complete/);
});

for (const [failure, message] of [
  ["boundary", /Raw source boundary changed/],
  ["target", /is not healthy/],
  ["snapshot", /snapshot differs from authority state/],
  ["eventChain", /event\/snapshot chain is not continuous/],
  ["checkpoint", /did not reach the captured generation\/boundary/],
]) {
  test(`stage 8 verification closes the start gate on ${failure} failure`, async () => {
    const harness = makeHarness({ verificationFailure: failure });
    const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
    assert.equal(report.status, "failed");
    assert.equal(report.canStartService, false);
    assert.match(report.error.message, message);
  });
}
