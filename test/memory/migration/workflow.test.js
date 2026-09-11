const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGET_KEYS, SCHEMA_VERSION } = require("../../../modules/memory/contracts");
const { createMemoryMigration } = require("../../../modules/memory/application/migration");
const { createOperationRunner } = require("../../../modules/memory/application/operationRunner");

function waitingHarness(onSleep = () => {}) {
  let time = Date.parse("2026-07-13T00:00:00Z");
  const runner = createOperationRunner({ now: () => time, sleepUntilNext: async ms => { time += ms; await onSleep(); } });
  return { ...makeHarness({ operationRunner: runner, now: () => new Date(time) }), time: () => time };
}

test("foreground migration waits through normal, capacity and final Librarian deferrals in one generation", async () => {
  const h = waitingHarness(); const complete = h.sourceRebuild.forceDrainTo; const optionsSeen = []; let calls = 0;
  h.sourceRebuild.forceDrainTo = async (_u, _p, options) => {
    optionsSeen.push(options); calls++;
    const pending = { status: "retry_wait", reason: "llm_call_failed", taskId: `task-${calls}`, notBefore: new Date(h.time() + 60_000).toISOString() };
    if (calls === 1) return { status: "incomplete", results: [{ ...pending, status: "error", halted: false }] };
    if (calls === 2) return { status: "incomplete", result: pending, results: [{ status: "capacity_deferred" }, pending] };
    if (calls === 3) return { status: "incomplete", reason: "librarian_final_not_terminal", result: { status: "incomplete", results: [pending] } };
    return complete();
  };
  const report = await h.migration.run();
  assert.equal(report.status, "completed"); assert.equal(calls, 4); assert.equal(h.getInitializeCount(), 1);
  assert.ok(optionsSeen.every(options => options.sourceGeneration === 1 && options.boundaryMessageId === 20));
  assert.deepEqual(report.results[0].verification.healthyProjections, ["rag"]);
});

test("foreground migration cancellation leaves the existing generation resumable", async () => {
  const controller = new AbortController(); const h = waitingHarness(() => controller.abort()); const complete = h.sourceRebuild.forceDrainTo; let calls = 0;
  h.sourceRebuild.forceDrainTo = async () => { calls++; return { status: "incomplete", result: { status: "retry_wait", reason: "llm_call_failed", notBefore: new Date(h.time() + 60_000).toISOString() } }; };
  const first = await h.migration.run({ signal: controller.signal });
  assert.equal(first.error.detail.status, "interrupted"); assert.equal(first.error.detail.resumable, true);
  assert.equal(calls, 1); assert.equal(first.canStartService, false);
  h.sourceRebuild.forceDrainTo = complete;
  assert.equal((await h.migration.run()).status, "completed"); assert.equal(h.getInitializeCount(), 1);
});

test("foreground migration never automatically resumes halted or schema-invalid work", async () => {
  for (const pending of [{ status: "halted", reason: "output_schema_invalid" }, { status: "error", halted: true, notBefore: "2026-07-13T00:01:00Z" }]) {
    const h = waitingHarness(() => assert.fail("terminal failure must not wait")); let calls = 0;
    h.sourceRebuild.forceDrainTo = async () => { calls++; return { status: "incomplete", result: pending }; };
    assert.equal((await h.migration.run()).status, "failed"); assert.equal(calls, 1);
  }
});

test("foreground migration aborts on cancellation or changed source before redispatch", async () => {
  for (const mode of ["cancel", "boundary", "privacy"]) {
    const controller = new AbortController(); let h; let calls = 0;
    h = waitingHarness(() => {
      if (mode === "cancel") controller.abort();
      else if (mode === "boundary") h.repositories.source.getBoundary = async () => 21;
      else h.repositories.privacy.hasIncompleteOperation = async () => true;
    });
    h.sourceRebuild.forceDrainTo = async () => { calls++; return { status: "incomplete", result: { status: "retry_wait", notBefore: new Date(h.time() + 60_000).toISOString() } }; };
    const report = await h.migration.run({ signal: controller.signal });
    assert.equal(report.status, "failed"); assert.equal(calls, 1);
    if (mode === "cancel") assert.equal(report.error.detail.status, "interrupted");
    else assert.match(report.error.message, mode === "boundary" ? /boundary changed/ : /privacy operation/);
  }
});

test("RAG transient failures wait without repeating Memory drain; permanent errors stop", async () => {
  for (const status of [503, 401]) {
    const h = waitingHarness(); const complete = h.projectionDrains.rag.drain; let calls = 0; let memoryCalls = 0;
    const drain = h.sourceRebuild.forceDrainTo;
    h.sourceRebuild.forceDrainTo = async (...args) => { memoryCalls++; return drain(...args); };
    h.projectionDrains.rag.drain = async () => { if (++calls <= 4) throw Object.assign(new Error("embedding unavailable"), { status }); return complete(); };
    const report = await h.migration.run();
    assert.equal(report.status, status === 503 ? "completed" : "failed");
    assert.equal(calls, status === 503 ? 5 : 1); assert.equal(memoryCalls, 1); assert.equal(h.getInitializeCount(), 1);
  }
});

for (const [status, expectedCalls] of [[503, 6], [undefined, 3]]) {
  test(`RAG ${status || "unknown"} failure budget stops one run and manual re-entry retains generation`, async () => {
    const h = waitingHarness(); const complete = h.projectionDrains.rag.drain; let calls = 0;
    h.projectionDrains.rag.drain = async () => { calls++; throw Object.assign(new Error("embedding unavailable"), { status }); };
    const failed = await h.migration.run();
    assert.equal(failed.status, "failed");
    assert.equal(calls, expectedCalls);
    assert.match(JSON.stringify(failed.error), /retry_budget_exhausted/);
    h.projectionDrains.rag.drain = complete;
    assert.equal((await h.migration.run()).status, "completed");
    assert.equal(h.getInitializeCount(), 1);
  });
}

test("successful embedding requests reset RAG failures before the next failure even within a drain", async () => {
  const h = waitingHarness(); const complete = h.projectionDrains.rag.drain; let calls = 0;
  h.projectionDrains.rag.drain = async () => {
    if (++calls <= 8) throw Object.assign(new Error("partial batch failed"), { status: 503, providerSuccessCount: calls });
    return complete();
  };
  assert.equal((await h.migration.run()).status, "completed");
  assert.equal(calls, 9);
});

test("an already cancelled rebuild cannot initialize or purge", async () => {
  const h = waitingHarness(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.migration.rebuildScope(migrationScenario.scope, migrationScenario.history, { signal: controller.signal }), /did not complete/);
  assert.equal(h.getInitializeCount(), 0); assert.deepEqual(h.getPurgeCounts(), { derivedPurges: 0, authorityPurges: 0 });
});

const migrationScenario = Object.freeze({
  scope: { userId: 7, presetId: "companion" },
  history: { messageCount: 20, characterCount: 4096, boundaryMessageId: 20 },
  sourceGeneration: 1,
  revision: 1,
});

function makeHarness({ projectionFailure = null, verificationFailure = null, forceDrainFailureOnce = false, forceDrainStale = false, inventoryChanges = false, providerTelemetry = null, initialAuthority = false, incompatibleDerivedData = false, operationRunner, now = () => new Date("2026-07-13T00:00:00.000Z") } = {}) {
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
    runtime: {
      async getTargetStatuses() { return structuredClone(statuses); },
      async listTasksForTarget() { return []; },
      async getTargetStatus() { return null; },
    },
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
      if (forceDrainStale) {
        return {
          status: "stale",
          sourceGeneration: migrationScenario.sourceGeneration,
          targetKey: "scene",
          reason: "wave_baseline_mismatch",
          results: [],
        };
      }
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
  const migration = createMemoryMigration({ providerRecovery: { retryMax: 2, transientRetryMax: 5, backoffBaseMs: 30000, backoffMaxMs: 120000 }, repositories, sourceRebuild, projectionDrains, providerTelemetry, now, operationRunner, monotonicNow: () => (clock += 5) });
  return { migration, repositories, sourceRebuild, projectionDrains, getInitializeCount: () => initializeCount, getPurgeCounts: () => ({ derivedPurges, authorityPurges }) };
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
    completedTaskCount: 0,
  });
  const second = await harness.migration.run({ mode: "cutover", serviceStopped: true });
  assert.equal(second.status, "completed");
  assert.equal(second.canStartService, true);
  assert.equal(harness.getInitializeCount(), 1);
});

test("migration failure detail preserves the top-level stale reason", async () => {
  const harness = makeHarness({ forceDrainStale: true });
  const report = await harness.migration.run({ mode: "rehearsal" });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.error.detail, {
    sourceGeneration: migrationScenario.sourceGeneration,
    targetKey: "scene",
    reason: "wave_baseline_mismatch",
    result: null,
    completedTaskCount: 0,
  });
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
