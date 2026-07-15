const { isDeepStrictEqual } = require("node:util");
const crypto = require("node:crypto");
const { assertMemoryState, SCHEMA_VERSION, TARGET_KEYS } = require("../contracts");

function rowValue(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function normalizeScope(scope) {
  const userId = Number(scope?.userId ?? scope?.user_id);
  const presetId = String(scope?.presetId ?? scope?.preset_id ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) throw new Error("Invalid migration scope");
  return { userId, presetId };
}

function codePointLength(value) {
  return Array.from(String(value ?? "")).length;
}

function summarizeCapacity(state) {
  const sceneValues = Object.values(state.current.scene)
    .map((field) => field?.value)
    .filter((value) => typeof value === "string" && value.length > 0);
  const sections = {
    todos: state.working.todos,
    standingAgreements: state.working.standingAgreements,
    recentEpisodes: state.working.recentEpisodes,
    milestones: state.longTerm.milestones,
    worldFacts: state.longTerm.worldFacts,
    userProfile: state.longTerm.userProfile,
    assistantProfile: state.longTerm.assistantProfile,
    relationship: state.longTerm.relationship,
  };
  return {
    scene: {
      itemCount: sceneValues.length > 0 ? 1 : 0,
      textChars: sceneValues.reduce((sum, value) => sum + codePointLength(value), 0),
    },
    ...Object.fromEntries(Object.entries(sections).map(([section, items]) => [section, {
      itemCount: items.length,
      textChars: items.reduce((sum, item) => sum + codePointLength(item?.text), 0),
    }])),
  };
}

function sourceInventorySnapshot(rows) {
  const scopes = rows.map((row) => ({ ...row })).sort((left, right) => (
    left.userId - right.userId || left.presetId.localeCompare(right.presetId)
  ));
  const serialized = JSON.stringify(scopes);
  return {
    scopeCount: scopes.length,
    messageCount: scopes.reduce((sum, scope) => sum + Number(scope.messageCount ?? 0), 0),
    characterCount: scopes.reduce((sum, scope) => sum + Number(scope.characterCount ?? 0), 0),
    sha256: `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`,
    contentFingerprintCoverageComplete: scopes.every((scope) => /^sha256:[a-f0-9]{64}$/.test(scope.sourceFingerprint)),
    scopes,
  };
}

function createMemoryMigration({
  repositories,
  sourceRebuild,
  projectionDrains,
  providerTelemetry = null,
  now = () => new Date(),
  monotonicNow = () => Date.now(),
} = {}) {
  if (!repositories?.withTransaction || !repositories?.state || !repositories?.source || !repositories?.runtime || !repositories?.audit || !repositories?.sidecars
    || !repositories?.migration?.listSourceScopes) {
    throw new Error("Memory migration repositories are required");
  }
  if (!sourceRebuild?.initializeGeneration || !sourceRebuild?.forceDrainTo) throw new Error("Memory migration requires source rebuild");
  if (!projectionDrains?.rag?.drain) throw new Error("Memory migration requires the rag projection drain");

  async function inventory(scopes) {
    const selected = scopes
      ? scopes.map(normalizeScope)
      : (await repositories.migration.listSourceScopes()).map(normalizeScope);
    const rows = [];
    for (const scope of selected) {
      const history = await repositories.source.getHistoryMetrics(scope.userId, scope.presetId);
      const sourceFingerprint = repositories.source.getHistoryFingerprint
        ? await repositories.source.getHistoryFingerprint(scope.userId, scope.presetId)
        : null;
      rows.push({ ...scope, ...history, sourceFingerprint });
    }
    return rows;
  }

  async function verifyScope(userId, presetId, expectedBoundary) {
    const state = await repositories.state.getState(userId, presetId);
    if (!state) throw new Error("Migration verification found no authority state");
    assertMemoryState(state);
    const generation = state.meta.sourceGeneration;
    const boundary = await repositories.source.getBoundary(userId, presetId);
    if (boundary !== expectedBoundary) throw new Error("Raw source boundary changed during migration");

    const statuses = await repositories.runtime.getTargetStatuses(userId, presetId);
    const byTarget = new Map(statuses.map((row) => [rowValue(row, "target_key", "targetKey"), row]));
    for (const targetKey of TARGET_KEYS) {
      const status = byTarget.get(targetKey);
      if (!status || rowValue(status, "status", "status") !== "healthy") throw new Error(`Target ${targetKey} is not healthy after migration`);
      if (Number(rowValue(status, "source_generation", "sourceGeneration")) !== generation) throw new Error(`Target ${targetKey} generation mismatch`);
      if ((state.meta.targetCursors[targetKey] ?? 0) !== boundary) throw new Error(`Target ${targetKey} did not reach the captured boundary`);
    }

    const snapshot = await repositories.audit.getSnapshot(userId, presetId, state.meta.revision);
    if (!snapshot || Number(rowValue(snapshot, "source_generation", "sourceGeneration")) !== generation) throw new Error("Current revision snapshot is missing or stale");
    if (Number(rowValue(snapshot, "schema_version", "schemaVersion")) !== SCHEMA_VERSION) throw new Error("Current revision snapshot schema mismatch");
    assertMemoryState(snapshot.state);
    if (!isDeepStrictEqual(snapshot.state, state)) throw new Error("Current revision snapshot differs from authority state");

    const snapshots = await repositories.audit.listSnapshots(userId, presetId, generation);
    const revisions = new Set(snapshots.map((row) => Number(row.revision)));
    const anchor = Number(snapshots[0]?.revision);
    if (!Number.isSafeInteger(anchor)) throw new Error("Migration generation has no valid anchor snapshot");
    const groups = await repositories.audit.listRevisionGroups(userId, presetId, generation, anchor);
    let expectedRevision = anchor + 1;
    for (const group of groups) {
      if (Number(rowValue(group, "base_revision", "baseRevision")) !== expectedRevision - 1
        || Number(rowValue(group, "result_revision", "resultRevision")) !== expectedRevision
        || !revisions.has(expectedRevision)) throw new Error("Migration event/snapshot chain is not continuous");
      expectedRevision += 1;
    }
    if (expectedRevision - 1 !== state.meta.revision) throw new Error("Migration event/snapshot chain does not reach authority state");

    const checkpoints = await repositories.sidecars.listProjectionCheckpoints(userId, presetId);
    const byProjection = new Map(checkpoints.map((row) => [rowValue(row, "projection_key", "projectionKey"), row]));
    for (const projectionKey of ["rag"]) {
      const checkpoint = byProjection.get(projectionKey);
      if (!checkpoint || rowValue(checkpoint, "status", "status") !== "healthy") throw new Error(`Projection ${projectionKey} is not healthy after migration`);
      if (Number(rowValue(checkpoint, "processed_generation", "processedGeneration")) !== generation
        || Number(rowValue(checkpoint, "processed_boundary_message_id", "processedBoundaryMessageId") ?? 0) !== boundary) {
        throw new Error(`Projection ${projectionKey} did not reach the captured generation/boundary`);
      }
    }
    return {
      sourceGeneration: generation,
      revision: state.meta.revision,
      boundaryMessageId: boundary,
      sectionUsage: summarizeCapacity(state),
      verification: {
        rawBoundaryStable: true,
        healthyTargetCount: TARGET_KEYS.length,
        targetCursorsAtBoundary: true,
        authoritySnapshotEqual: true,
        eventSnapshotChainContinuous: true,
        healthyProjections: ["rag"],
      },
    };
  }

  async function findResumableGeneration(scope, history) {
    const state = await repositories.state.getState(scope.userId, scope.presetId);
    if (!state) return null;
    const boundary = await repositories.source.getBoundary(scope.userId, scope.presetId);
    if (boundary !== history.boundaryMessageId) throw new Error("Raw source boundary changed after migration inventory");
    const statuses = await repositories.runtime.getTargetStatuses(scope.userId, scope.presetId);
    const byTarget = new Map(statuses.map((row) => [rowValue(row, "target_key", "targetKey"), row]));
    const generation = state.meta.sourceGeneration;
    const hasActiveRebuildBoundary = statuses.some((status) => (
      Number(rowValue(status, "source_generation", "sourceGeneration")) === generation
      && Number(rowValue(status, "rebuild_boundary_message_id", "rebuildBoundaryMessageId")) === boundary
    ));
    const resumable = TARGET_KEYS.every((targetKey) => {
      const status = byTarget.get(targetKey);
      if (!status || Number(rowValue(status, "source_generation", "sourceGeneration")) !== generation) return false;
      const cursor = state.meta.targetCursors[targetKey] ?? 0;
      if (cursor >= boundary) return true;
      return hasActiveRebuildBoundary
        || Number(rowValue(status, "rebuild_boundary_message_id", "rebuildBoundaryMessageId")) === boundary;
    });
    if (!resumable) return null;
    return { sourceGeneration: generation, revision: state.meta.revision, boundaryMessageId: boundary, resumed: true };
  }

  function forceDrainError(drained) {
    const error = new Error(`Memory force drain did not complete: ${drained.status}`);
    error.migrationDetail = {
      sourceGeneration: drained.sourceGeneration ?? null,
      targetKey: drained.targetKey ?? null,
      result: drained.result ? {
        status: drained.result.status ?? null,
        outcome: drained.result.outcome ?? null,
        reason: drained.result.reason ?? null,
        taskId: drained.result.taskId ?? null,
      } : null,
      completedTaskCount: Array.isArray(drained.results) ? drained.results.length : 0,
    };
    return error;
  }

  async function rebuildScope(scope, history, { forceNewGeneration = false } = {}) {
    const started = monotonicNow();
    const providerMark = providerTelemetry?.mark?.() ?? 0;
    let state = await repositories.state.getState(scope.userId, scope.presetId);
    if (!state) state = await repositories.state.initializeRevisionZero(scope.userId, scope.presetId);
    const initialized = (forceNewGeneration ? null : await findResumableGeneration(scope, history))
      ?? await sourceRebuild.initializeGeneration(scope.userId, scope.presetId, {
        reason: forceNewGeneration ? "manual_cli_rebuild" : "memory_v2_migration",
      });
    if (initialized.boundaryMessageId !== history.boundaryMessageId) throw new Error("Raw source boundary changed after migration inventory");
    const drained = await sourceRebuild.forceDrainTo(scope.userId, scope.presetId, initialized);
    if (drained.status !== "completed") throw forceDrainError(drained);
    for (const projectionKey of ["rag"]) {
      const result = await projectionDrains[projectionKey].drain(scope.userId, scope.presetId);
      if (result.status !== "healthy") throw new Error(`Projection ${projectionKey} drain did not complete: ${result.status}`);
    }
    const verified = await verifyScope(scope.userId, scope.presetId, history.boundaryMessageId);
    return {
      ...scope,
      ...history,
      ...verified,
      normalTaskCount: Array.isArray(drained.results) ? drained.results.length : 0,
      providerUsage: providerTelemetry?.snapshot?.(providerMark) ?? null,
      durationMs: Math.max(0, monotonicNow() - started),
    };
  }

  async function run({ mode = "rehearsal", serviceStopped = false, scopes } = {}) {
    if (!["rehearsal", "cutover"].includes(mode)) throw new Error("Migration mode must be rehearsal or cutover");
    if (mode === "cutover" && !serviceStopped) throw new Error("Cutover requires serviceStopped=true");
    const startedAt = now().toISOString();
    const started = monotonicNow();
    const providerMark = providerTelemetry?.mark?.() ?? 0;
    let beforeSourceInventory = null;
    let afterSourceInventory = null;
    let histories = [];
    const results = [];
    try {
      const globalBefore = await inventory();
      beforeSourceInventory = sourceInventorySnapshot(globalBefore);
      histories = scopes ? await inventory(scopes) : globalBefore;
      for (const history of histories) {
        const scope = { userId: history.userId, presetId: history.presetId };
        results.push(await rebuildScope(scope, history));
      }
      afterSourceInventory = sourceInventorySnapshot(await inventory());
      if (!isDeepStrictEqual(beforeSourceInventory.scopes, afterSourceInventory.scopes)) {
        throw new Error("Global raw source inventory changed during migration");
      }
      return {
        status: "completed", mode, startedAt, completedAt: now().toISOString(), durationMs: Math.max(0, monotonicNow() - started),
        scopeCount: histories.length, results,
        providerUsage: providerTelemetry?.snapshot?.(providerMark) ?? null,
        sourceInventory: { before: beforeSourceInventory, after: afterSourceInventory, unchanged: true },
        canStartService: mode === "cutover",
      };
    } catch (error) {
      if (!afterSourceInventory && beforeSourceInventory) {
        try { afterSourceInventory = sourceInventorySnapshot(await inventory()); }
        catch { afterSourceInventory = null; }
      }
      return {
        status: "failed", mode, startedAt, failedAt: now().toISOString(), durationMs: Math.max(0, monotonicNow() - started),
        scopeCount: histories.length, results, canStartService: false,
        providerUsage: providerTelemetry?.snapshot?.(providerMark) ?? null,
        sourceInventory: {
          before: beforeSourceInventory,
          after: afterSourceInventory,
          unchanged: Boolean(beforeSourceInventory && afterSourceInventory
            && isDeepStrictEqual(beforeSourceInventory.scopes, afterSourceInventory.scopes)),
        },
        error: {
          name: error?.name || "Error",
          message: String(error?.message || error),
          ...(error?.migrationDetail ? { detail: error.migrationDetail } : {}),
        },
      };
    }
  }

  return Object.freeze({ inventory, verifyScope, rebuildScope, run });
}

module.exports = { createMemoryMigration };
