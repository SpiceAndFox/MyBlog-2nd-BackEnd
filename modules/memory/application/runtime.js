const { createObserver } = require("./observer");
const { createNormalWritePipeline } = require("./normalWritePipeline");
const { createMemoryRecovery } = require("./recovery");
const { createMemoryHousekeeping } = require("./housekeeping");
const { createMemorySourceRebuild } = require("./sourceRebuild");
const { createMemoryStateRecovery } = require("./stateRecovery");
const { createMemoryProviderAdapter } = require("../infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("../infrastructure/providers/structuredTransportFactory");
const { runStructuredOutputPreflight } = require("../infrastructure/providers/providerPreflight");
const { loadProposerPrompt } = require("../prompts");
const { createMemoryMetrics } = require("./metrics");
const { createDiagnosticProjection } = require("./diagnosticProjection");
const { createPrivacyHardDelete } = require("./privacyHardDelete");
const { createMemoryRetention } = require("./retention");

function createKeyedExecutor() {
  const lanes = new Map();
  return function enqueueByKey(key, work) {
    const previous = lanes.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    lanes.set(key, current);
    const release = () => { if (lanes.get(key) === current) lanes.delete(key); };
    void current.then(release, release);
    return current;
  };
}

function createDisabledRuntime(repositories) {
  const disabled = async () => ({ status: "disabled" });
  const stopProjectionPolling = () => {};
  const stopTaskPolling = () => {};
  async function mutateSourceAndRebuild(_userId, _presetId, { mutateSource } = {}) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
    const mutationResult = repositories?.withTransaction
      ? await repositories.withTransaction((client) => mutateSource(client))
      : await mutateSource(null);
    return { status: "memory_disabled", mutationResult };
  }
  async function privacyHardDelete(_userId, _presetId, { deleteRawSource } = {}) {
    return mutateSourceAndRebuild(_userId, _presetId, { mutateSource: deleteRawSource });
  }
  return Object.freeze({
    enabled: false,
    initialize: async () => [],
    ensureScope: disabled,
    processScope: disabled,
    rebuildScope: disabled,
    mutateSourceAndRebuild,
    privacyHardDelete,
    runRetentionScope: disabled,
    reconcileRebuilds: async () => ({}),
    drainProjections: disabled,
    reconcileProjections: async () => ({}),
    startProjectionPolling: () => stopProjectionPolling,
    stopProjectionPolling,
    startTaskPolling: () => stopTaskPolling,
    stopTaskPolling,
    scheduleHousekeeping: disabled,
    scheduleStateRecovery: disabled,
    resumeTarget: disabled,
    recoverPending: async () => [],
  });
}

function createMemoryRuntime({ config, repositories, providerAdapter, projectionDrains = {}, privacyStores = [], metrics = createMemoryMetrics(), onBackgroundError } = {}) {
  if (!config?.enabled) return createDisabledRuntime(repositories);
  if (!repositories?.state || !repositories?.source || !repositories?.runtime) {
    throw new Error("Memory runtime repositories are required");
  }

  const enqueueByKey = createKeyedExecutor();
  const invokeStructured = providerAdapter ? null : createStructuredTransport(config.provider);
  const adapter = providerAdapter || createMemoryProviderAdapter({ invokeStructured, promptLoader: loadProposerPrompt });
  let providerInitialization = providerAdapter ? Promise.resolve([]) : null;
  function initialize() {
    if (!providerInitialization) {
      providerInitialization = runStructuredOutputPreflight({ invokeStructured, promptLoader: loadProposerPrompt });
    }
    return providerInitialization;
  }
  const observer = createObserver({
    sourceRepository: repositories.source,
    stateRepository: repositories.state,
    runtimeRepository: repositories.runtime,
    config, metrics,
  });
  const pipeline = createNormalWritePipeline({ observer, providerAdapter: adapter, repositories, config, metrics });
  const sourceRebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config });
  const privacyDelete = repositories.privacy ? createPrivacyHardDelete({ repositories, sourceRebuild, stores: privacyStores, enqueueByKey }) : null;
  const stateRecovery = createMemoryStateRecovery({ repositories, sourceRebuild });
  const recovery = createMemoryRecovery({ repositories, pipeline, enqueueByKey, metrics, onDispatchError: onBackgroundError });
  const housekeeping = createMemoryHousekeeping({ repositories, config, enqueueByKey });
  const diagnosticProjection = repositories.diagnosticProjection
    ? createDiagnosticProjection({ repositories })
    : null;
  const retention = config.retention ? createMemoryRetention({ repositories, config, diagnosticProjection }) : null;
  let projectionPollTimer = null;
  let projectionPollRunning = false;
  let taskPollTimer = null;
  let taskPollRunning = false;

  async function ensureState(userId, presetId) {
    try {
      return (await repositories.state.getState(userId, presetId))
        || repositories.state.initializeRevisionZero(userId, presetId);
    } catch (error) {
      if (error?.code !== "MEMORY_V2_STATE_INVALID" || !repositories.state.getRawState || !repositories.audit.getRecoveryHead || !repositories.audit.listSnapshotsForRecovery) throw error;
      const recovered = await stateRecovery.recoverScope(userId, presetId);
      if (!["healthy", "snapshot_restored", "rebuilt"].includes(recovered.status)) throw new Error(`Memory state recovery did not complete: ${recovered.status}`);
      return recovered.state ?? repositories.state.getState(userId, presetId);
    }
  }

  function ensureScope({ userId, presetId } = {}) {
    return enqueueByKey(`${userId}:${presetId}`, () => ensureState(userId, presetId));
  }

  function runInBackground(work) {
    const promise = Promise.resolve().then(work);
    if (typeof onBackgroundError === "function") promise.catch(onBackgroundError);
    return promise;
  }

  async function drainProjectionsNow(userId, presetId) {
    const results = {};
    if (diagnosticProjection) {
      const startedAt = performance.now();
      try {
        results.diagnostics = await diagnosticProjection.syncScope(userId, presetId);
        metrics.observe("memory_projection_duration_ms", { projectionKey: "diagnostics", status: results.diagnostics.status }, performance.now() - startedAt);
      } catch (error) {
        results.diagnostics = { status: "failed", reason: String(error?.code || error?.name || "projection_failed").slice(0, 200) };
        onBackgroundError?.(error);
        metrics.observe("memory_projection_duration_ms", { projectionKey: "diagnostics", status: "failed" }, performance.now() - startedAt);
      }
    }
    for (const projectionKey of ["rag", "recall"]) {
      const drain = projectionDrains[projectionKey];
      if (!drain?.drain) continue;
      const startedAt = performance.now();
      try {
        results[projectionKey] = await drain.drain(userId, presetId);
        metrics.observe("memory_projection_duration_ms", { projectionKey, status: results[projectionKey]?.status ?? "unknown" }, performance.now() - startedAt);
      } catch (error) {
        results[projectionKey] = {
          status: "failed",
          reason: String(error?.code || error?.name || "projection_failed").slice(0, 200),
        };
        onBackgroundError?.(error);
        metrics.observe("memory_projection_duration_ms", { projectionKey, status: "failed" }, performance.now() - startedAt);
      }
    }
    return results;
  }

  function drainProjections(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, () => drainProjectionsNow(userId, presetId)));
  }

  async function reconcileProjections() {
    if (typeof repositories.state.listInitializedScopes !== "function") return {};
    const scopes = await repositories.state.listInitializedScopes();
    const results = {};
    for (const scope of scopes) {
      const userId = Number(scope.userId ?? scope.user_id);
      const presetId = String(scope.presetId ?? scope.preset_id ?? "").trim();
      if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) continue;
      results[`${userId}:${presetId}`] = await enqueueByKey(
        `${userId}:${presetId}`,
        () => drainProjectionsNow(userId, presetId),
      );
    }
    return results;
  }

  async function reconcileRebuilds() {
    if (typeof repositories.state.listInitializedScopes !== "function") return {};
    const scopes = await repositories.state.listInitializedScopes();
    const results = {};
    for (const scope of scopes) {
      const userId = Number(scope.userId ?? scope.user_id);
      const presetId = String(scope.presetId ?? scope.preset_id ?? "").trim();
      if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) continue;
      results[`${userId}:${presetId}`] = await enqueueByKey(`${userId}:${presetId}`, async () => {
        const state = await ensureState(userId, presetId);
        const statuses = await repositories.runtime.getTargetStatuses(userId, presetId);
        const rebuilding = statuses.filter((row) => {
          const boundary = row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId;
          return Number(row.source_generation ?? row.sourceGeneration) === state.meta.sourceGeneration && boundary !== null && boundary !== undefined;
        });
        if (!rebuilding.length) return { status: "skipped", reason: "not_rebuilding" };
        const boundaries = [...new Set(rebuilding.map((row) => Number(row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId)))];
        if (boundaries.length !== 1) throw new Error("Memory rebuilding targets have inconsistent boundaries");
        return sourceRebuild.forceDrainTo(userId, presetId, { sourceGeneration: state.meta.sourceGeneration, boundaryMessageId: boundaries[0] });
      });
    }
    return results;
  }

  function stopProjectionPolling() {
    if (!projectionPollTimer) return;
    clearInterval(projectionPollTimer);
    projectionPollTimer = null;
  }

  function startProjectionPolling() {
    if (projectionPollTimer) return stopProjectionPolling;
    const intervalMs = Number(config?.projections?.pollIntervalMs);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
      throw new Error("Memory projection pollIntervalMs must be a safe integer >= 1000");
    }
    const tick = () => {
      if (projectionPollRunning) return;
      projectionPollRunning = true;
      runInBackground(reconcileProjections).finally(() => { projectionPollRunning = false; });
    };
    projectionPollTimer = setInterval(tick, intervalMs);
    projectionPollTimer.unref?.();
    return stopProjectionPolling;
  }

  function stopTaskPolling() {
    if (!taskPollTimer) return;
    clearInterval(taskPollTimer);
    taskPollTimer = null;
  }

  function startTaskPolling() {
    if (taskPollTimer) return stopTaskPolling;
    const intervalMs = Number(config?.tasks?.pollIntervalMs ?? 1000);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
      throw new Error("Memory task pollIntervalMs must be a safe integer >= 250");
    }
    const tick = () => {
      if (taskPollRunning) return;
      taskPollRunning = true;
      runInBackground(async () => {
        await recovery.recoverPending();
        await reconcileRebuilds();
      }).finally(() => { taskPollRunning = false; });
    };
    taskPollTimer = setInterval(tick, intervalMs);
    taskPollTimer.unref?.();
    return stopTaskPolling;
  }

  function processScope(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await initialize();
      await ensureState(userId, presetId);
      const memory = await pipeline.processScope(userId, presetId);
      const projections = await drainProjectionsNow(userId, presetId);
      return { memory, projections };
    }));
  }

  function rebuildScope(userId, presetId, { reason = "source_mutation" } = {}) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await initialize();
      const startedAt = performance.now();
      await ensureState(userId, presetId);
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, { reason });
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      metrics.observe("memory_rebuild_duration_ms", { reason, status: drained.status }, performance.now() - startedAt);
      const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId) : {};
      return { ...initialized, ...drained, projections };
    }));
  }

  async function mutateSourceAndRebuild(userId, presetId, { mutateSource, purgeDerived = null, reason = "source_mutation" } = {}) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
    await initialize();
    const initialized = await enqueueByKey(`${userId}:${presetId}`, async () => {
      await ensureState(userId, presetId);
      return sourceRebuild.initializeGeneration(userId, presetId, { mutateSource, purgeDerived, reason });
    });
    runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId) : {};
      return { ...drained, projections };
    }));
    return { status: "rebuilding", ...initialized };
  }

  async function recoverPending() {
    await initialize();
    await reconcileRebuilds();
    const recovered = await recovery.recoverPending();
    await reconcileRebuilds();
    await reconcileProjections();
    return recovered;
  }

  function scheduleHousekeeping({ userId, presetId, requestNow } = {}) {
    return runInBackground(() => housekeeping.runScope(userId, presetId, { requestNow }));
  }

  function scheduleStateRecovery({ userId, presetId } = {}) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, () => stateRecovery.recoverScope(userId, presetId)));
  }

  async function resumeTarget(userId, presetId, targetKey) {
    await initialize();
    const result = await enqueueByKey(`${userId}:${presetId}`, () => (
      recovery.resumeTarget(userId, presetId, targetKey, { run: false })
    ));
    // The resumed task must run after the preparation transaction releases the
    // scope lane. Dispatching it from inside that lane would self-deadlock.
    const recovered = await recovery.recoverPending();
    return { ...result, recovered };
  }

  function privacyHardDelete(userId, presetId, options) {
    if (!privacyDelete) throw new Error("Memory privacy hard delete is unavailable");
    return privacyDelete.execute(userId, presetId, options);
  }

  function runRetentionScope(userId, presetId) {
    if (!retention) throw new Error("Memory retention is not configured");
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, () => retention.runScope(userId, presetId)));
  }

  return Object.freeze({
    enabled: true,
    initialize,
    ensureScope,
    processScope,
    rebuildScope,
    mutateSourceAndRebuild,
    privacyHardDelete,
    runRetentionScope,
    reconcileRebuilds,
    drainProjections,
    reconcileProjections,
    startProjectionPolling,
    stopProjectionPolling,
    startTaskPolling,
    stopTaskPolling,
    scheduleHousekeeping,
    scheduleStateRecovery,
    resumeTarget,
    metrics,
    getMetricsSnapshot: () => metrics.snapshot(),
    recoverPending: () => runInBackground(recoverPending),
  });
}

module.exports = { createMemoryRuntime, createKeyedExecutor };
