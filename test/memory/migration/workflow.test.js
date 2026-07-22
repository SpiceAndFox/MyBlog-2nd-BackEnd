const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGET_KEYS, SCHEMA_VERSION } = require("../../../modules/memory/contracts");
const { createMemoryMigration } = require("../../../modules/memory/application/migration");

const migrationScenario = Object.freeze({
  scope: { userId: 7, presetId: "companion" },
  history: { messageCount: 20, characterCount: 4096, boundaryMessageId: 20 },
  sourceGeneration: 1,
  revision: 1,
});

function makeHarness({ projectionFailure = null, verificationFailure = null, forceDrainFailureOnce = false, inventoryChanges = false, providerTelemetry = null, initialAuthority = false, incompatibleDerivedData = false } = {}) {
  let state = initialAuthority ? createInitialMemoryState() : null;
  let snapshots = [];
  let statuses = [];
  let checkpoints = [];
  let clock = 0;
  let initializeCount = 0;
  let forceDrainCount = 0;
  let derivedPurges = 0;
  let authorityPurges = 0;
  let incompatible = incompatibleDerivedData;
  const repositories = {
    async withTransaction(work) { return work({ transaction: true }); },
    state: {
      async getRawState() { return state ? structuredClone(state) : null; },
      async getState() { return state ? structuredClone(state) : null; },
      async initializeRevisionZero() { state = createInitialMemoryState(); return structuredClone(state); },
    },
    source: {
      async listScopes() { return [migrationScenario.scope]; },
      async getHistoryMetrics() {
        return {
          ...migrationScenario.history,
          ...(inventoryChanges && forceDrainCount > 0 ? { messageCount: migrationScenario.history.messageCount + 1 } : {}),
        };
      },
      async getHistoryFingerprint() { return `sha256:${"f".repeat(64)}`; },
      async getBoundary() { return migrationScenario.history.boundaryMessageId + (verificationFailure === "boundary" ? 1 : 0); },
    },
    runtime: { async getTargetStatuses() { return structuredClone(statuses); } },
    audit: {
      async getSnapshot(_u, _p, revision) { return structuredClone(snapshots.find((entry) => entry.revision === revision) || null); },
      async listSnapshots() { return structuredClone(snapshots); },
      async listRevisionGroups() {
        if (verificationFailure !== "eventChain") return [];
        return [{ base_revision: migrationScenario.revision, result_revision: migrationScenario.revision + 2 }];
      },
    },
    sidecars: { async listProjectionCheckpoints() { return structuredClone(checkpoints); } },
    privacy: {
      async purgeDerivedHistory() { derivedPurges += 1; incompatible = false; snapshots = []; statuses = []; checkpoints = []; },
      async purgeAuthorityState() { authorityPurges += 1; state = null; },
    },
    migration: {
      async hasIncompatibleDerivedData() { return incompatible; },
    },
  };
  const sourceRebuild = {
    async initializeGeneration() {
      initializeCount += 1;
      state.meta.sourceGeneration = migrationScenario.sourceGeneration;
      state.meta.revision = migrationScenario.revision;
      snapshots = [{ source_generation: migrationScenario.sourceGeneration, revision: migrationScenario.revision, schema_version: SCHEMA_VERSION, state: structuredClone(state) }];
      statuses = TARGET_KEYS.map((targetKey) => ({
        target_key: targetKey,
        source_generation: migrationScenario.sourceGeneration,
        rebuild_boundary_message_id: migrationScenario.history.boundaryMessageId,
        status: "rebuilding",
      }));
      return { sourceGeneration: migrationScenario.sourceGeneration, revision: migrationScenario.revision, boundaryMessageId: migrationScenario.history.boundaryMessageId };
    },
    async forceDrainTo() {
      forceDrainCount += 1;
      if (forceDrainFailureOnce && forceDrainCount === 1) {
        statuses = statuses.map((status) => status.target_key === "scene"
          ? { ...status, status: "halted", rebuild_boundary_message_id: null }
          : status);
        return {
          status: "incomplete",
          sourceGeneration: migrationScenario.sourceGeneration,
          targetKey: "scene",
          result: { status: "queued", outcome: "transaction_failed", taskId: "task-1" },
          results: [{ status: "queued" }],
        };
      }
      state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((targetKey) => [targetKey, migrationScenario.history.boundaryMessageId]));
      state.current.scene.location = {
        value: "上海😊",
        sourceRefs: [{ messageId: migrationScenario.history.boundaryMessageId, contentHash: `sha256:${"a".repeat(64)}` }],
        updatedAtMessageId: migrationScenario.history.boundaryMessageId,
      };
      snapshots[0].state = structuredClone(state);
      statuses = TARGET_KEYS.map((targetKey) => ({ target_key: targetKey, source_generation: migrationScenario.sourceGeneration, status: "healthy" }));
      if (verificationFailure === "target") statuses[0].status = "halted";
      if (verificationFailure === "snapshot") snapshots[0].state.current.scene.location = createInitialMemoryState().current.scene.location;
      return { status: "completed" };
    },
  };
  const projectionDrains = Object.fromEntries(["rag"].map((projectionKey) => [projectionKey, {
    async drain() {
      if (projectionFailure === projectionKey) return { status: "stale" };
      checkpoints.push({
        projection_key: projectionKey,
        processed_generation: migrationScenario.sourceGeneration,
        processed_boundary_message_id: migrationScenario.history.boundaryMessageId - (verificationFailure === "checkpoint" ? 1 : 0),
        status: "healthy",
      });
      return { status: "healthy" };
    },
  }]));
  const migration = createMemoryMigration({ repositories, sourceRebuild, projectionDrains, providerTelemetry, now: () => new Date("2026-07-13T00:00:00.000Z"), monotonicNow: () => (clock += 5) });
  return { migration, getInitializeCount: () => initializeCount, getPurgeCounts: () => ({ derivedPurges, authorityPurges }) };
}

test("migration rehearsal rebuilds every raw-history scope", async () => {
  const harness = makeHarness();
  const report = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(report.status, "completed");
  assert.deepEqual(harness.getPurgeCounts(), { derivedPurges: 1, authorityPurges: 1 });
  assert.equal(report.canStartService, false);
  assert.equal(report.scopeCount, 1);
  assert.equal(report.results[0].messageCount, migrationScenario.history.messageCount);
  assert.equal(report.results[0].characterCount, migrationScenario.history.characterCount);
  assert.equal(report.results[0].boundaryMessageId, migrationScenario.history.boundaryMessageId);
  assert.deepEqual(report.results[0].sectionUsage.scene, { itemCount: 1, textChars: 3 });
  assert.deepEqual(report.results[0].sectionUsage.todos, { itemCount: 0, textChars: 0 });
  assert.deepEqual(report.results[0].verification, {
    rawBoundaryStable: true,
    healthyTargetCount: TARGET_KEYS.length,
    targetCursorsAtBoundary: true,
    authoritySnapshotEqual: true,
    eventSnapshotChainContinuous: true,
    healthyProjections: ["rag"],
  });
  assert.equal(report.sourceInventory.unchanged, true);
  assert.equal(report.sourceInventory.before.contentFingerprintCoverageComplete, true);
  assert.equal(report.sourceInventory.before.sha256, report.sourceInventory.after.sha256);
  assert.equal(report.results[0].durationMs > 0, true);
});

test("migration purges mixed-version derived rows even when authority is already 2.01", async () => {
  const harness = makeHarness({ initialAuthority: true, incompatibleDerivedData: true });
  const report = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(report.status, "completed");
  assert.deepEqual(harness.getPurgeCounts(), { derivedPurges: 1, authorityPurges: 1 });
});

test("migration closes the service gate when the global raw-source inventory changes", async () => {
  const harness = makeHarness({ inventoryChanges: true });
  const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(report.status, "failed");
  assert.equal(report.canStartService, false);
  assert.equal(report.sourceInventory.unchanged, false);
  assert.match(report.error.message, /Global raw source inventory changed/);
});

test("migration rehearsal is repeatable and never opens the service start gate", async () => {
  const harness = makeHarness();
  const first = await harness.migration.run({ mode: "rehearsal" });
  const second = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.canStartService, false);
});

test("an explicitly forced scoped rebuild starts a new generation after a completed run", async () => {
  const harness = makeHarness();
  const first = await harness.migration.run({ mode: "rehearsal" });
  assert.equal(first.status, "completed");
  assert.equal(harness.getInitializeCount(), 1);

  const [history] = await harness.migration.inventory([migrationScenario.scope]);
  const rebuilt = await harness.migration.rebuildScope(migrationScenario.scope, history, { forceNewGeneration: true });

  assert.equal(rebuilt.verification.healthyTargetCount, TARGET_KEYS.length);
  assert.equal(harness.getInitializeCount(), 2);
});

test("migration resumes an incomplete force drain without resetting its generation", async () => {
  const harness = makeHarness({ forceDrainFailureOnce: true });
  const first = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(first.status, "failed");
  assert.deepEqual(first.error.detail, {
    sourceGeneration: migrationScenario.sourceGeneration,
    targetKey: "scene",
    result: { status: "queued", outcome: "transaction_failed", reason: null, taskId: "task-1" },
    completedTaskCount: 1,
  });
  const second = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(second.status, "completed");
  assert.equal(second.canStartService, true);
  assert.equal(harness.getInitializeCount(), 1);
});

test("migration cutover requires an explicitly stopped service", async () => {
  const harness = makeHarness();
  await assert.rejects(() => harness.migration.run({ mode: "cutover" }), /serviceStopped=true/);
});

test("migration cutover opens the start gate only after full verification", async () => {
  const harness = makeHarness();
  const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(report.status, "completed");
  assert.equal(report.canStartService, true);
});

test("a stale projection keeps the service start gate closed", async () => {
  const harness = makeHarness({ projectionFailure: "rag" });
  const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(report.status, "failed");
  assert.equal(report.canStartService, false);
  assert.match(report.error.message, /Projection rag drain did not complete/);
});

for (const [failure, message] of [
  ["boundary", /Raw source boundary changed/],
  ["target", /is not healthy/],
  ["snapshot", /snapshot differs from authority state/],
  ["eventChain", /event\/snapshot chain is not continuous/],
  ["checkpoint", /did not reach the captured generation\/boundary/],
]) {
  test(`migration verification closes the start gate on ${failure} failure`, async () => {
    const harness = makeHarness({ verificationFailure: failure });
    const report = await harness.migration.run({ mode: "cutover", serviceStopped: true });
    assert.equal(report.status, "failed");
    assert.equal(report.canStartService, false);
    assert.match(report.error.message, message);
  });
}
