const crypto = require("node:crypto");
const { SCHEMA_VERSION } = require("../contracts");
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
const { createProviderAdmission, admissionControlledAdapter } = require("./providerAdmission");

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

function startupRecoveryIssues({ privacy = {}, rebuildBefore = {}, tasks = [], pendingTasks = [], rebuildAfter = {}, projections = {} } = {}) {
  const issues = [];
  const inspectMap = (kind, values, accepted) => {
    for (const [scope, result] of Object.entries(values || {})) {
      const status = String(result?.status || "unknown");
      if (!accepted.has(status)) issues.push({ kind, scope, status });
    }
  };
  inspectMap("privacy", privacy, new Set(["completed"]));
  inspectMap("rebuild_before", rebuildBefore, new Set(["completed", "skipped"]));
  inspectMap("rebuild_after", rebuildAfter, new Set(["completed", "skipped"]));
  const failedTaskStatuses = new Set(["dispatch_failed", "failed", "queued", "retry_wait", "incomplete", "stale", "error"]);
  for (const result of tasks || []) {
    const status = String(result?.status || "unknown");
    if (failedTaskStatuses.has(status)) issues.push({ kind: "task", taskId: result?.taskId ?? null, status });
  }
  for (const task of pendingTasks || []) {
    issues.push({
      kind: "pending_task",
      taskId: task?.task_id ?? task?.taskId ?? null,
      status: String(task?.status || "unknown"),
    });
  }
  for (const [scope, result] of Object.entries(projections || {})) {
    for (const [projectionKey, projection] of Object.entries(result || {})) {
      const status = String(projection?.status || "unknown");
      const accepted = projectionKey === "diagnostics" ? status === "synced" : status === "healthy";
      if (!accepted) issues.push({ kind: "projection", scope, projectionKey, status });
    }
  }
  return issues;
}

function createDisabledRuntime(repositories, privacyStores = [], enqueueByKey = createKeyedExecutor()) {
  const disabled = async () => ({ status: "disabled" });
  const stopProjectionPolling = () => {};
  const stopTaskPolling = () => {};
  async function mutateSourceAndRebuild(_userId, _presetId, { mutateSource } = {}) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
    return enqueueByKey(`${_userId}:${_presetId}`, async () => {
      const mutationResult = repositories?.withTransaction
        ? await repositories.withTransaction((client) => mutateSource(client))
        : await mutateSource(null);
      return { status: "memory_disabled", mutationResult };
    });
  }
  const privacyDelete = repositories?.privacy
    ? createPrivacyHardDelete({ repositories, stores: privacyStores, enqueueByKey })
    : null;
  async function privacyHardDelete(userId, presetId, options = {}) {
    if (!privacyDelete) throw new Error("Memory privacy hard delete is unavailable");
    return privacyDelete.execute(userId, presetId, { ...options, resetAuthority: !options.deleteScope });
  }
  return Object.freeze({
    enabled: false,
    initialize: async () => [],
    ensureScope: disabled,
    processScope: disabled,
    rebuildScope: disabled,
    mutateSourceAndRebuild,
    privacyHardDelete,
    getPrivacyOperation: (userId, operationId) => repositories?.privacy?.getOperationById?.(userId, operationId) ?? Promise.resolve(null),
    hasIncompletePrivacyOperation: (userId, presetId) => repositories?.privacy?.hasIncompleteOperation?.(userId, presetId) ?? Promise.resolve(false),
    markRecoveryNotificationsDelivered: (ids) => repositories?.sidecars?.markRecoveryNotificationsDelivered?.(ids) ?? Promise.resolve([]),
    runRetentionScope: disabled,
    reconcileRebuilds: async () => ({}),
    reconcilePrivacyDeletes: () => privacyDelete?.reconcilePending() ?? Promise.resolve({}),
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
    shutdown: async () => {
      stopProjectionPolling();
      stopTaskPolling();
      await privacyDelete?.waitForIdle?.();
      return { status: "stopped" };
    },
  });
}

function createMemoryRuntime({ config, repositories, providerAdapter, projectionDrains = {}, privacyStores = [], metrics = createMemoryMetrics(), onBackgroundError, enqueueByKey: sharedEnqueueByKey } = {}) {
  const enqueueByKey = sharedEnqueueByKey || createKeyedExecutor();
  if (!config?.enabled) return createDisabledRuntime(repositories, privacyStores, enqueueByKey);
  if (!repositories?.state || !repositories?.source || !repositories?.runtime) {
    throw new Error("Memory runtime repositories are required");
  }
  const unsupportedProjectionKeys = Object.keys(projectionDrains).filter((projectionKey) => projectionKey !== "rag");
  if (unsupportedProjectionKeys.length) throw new Error(`Unsupported Memory projection drain: ${unsupportedProjectionKeys.join(",")}`);

  const admission = createProviderAdmission(config.admission || { concurrency: 1, queueMax: 32 });
  const rawInvokeStructured = providerAdapter ? null : createStructuredTransport(config.provider);
  const rawAdapter = providerAdapter || createMemoryProviderAdapter({ invokeStructured: rawInvokeStructured, promptLoader: loadProposerPrompt });
  const adapter = admissionControlledAdapter(rawAdapter, admission);
  let providerInitialization = providerAdapter ? Promise.resolve([]) : null;
  function initialize() {
    if (!providerInitialization) {
      providerInitialization = runStructuredOutputPreflight({
        invokeStructured: (request) => admission.run(() => rawInvokeStructured(request)),
        promptLoader: loadProposerPrompt,
      });
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
  const privacyDelete = repositories.privacy
    ? createPrivacyHardDelete({ repositories, sourceRebuild, stores: privacyStores, enqueueByKey, onBackgroundError })
    : null;
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
  const activeRebuilds = new Map();
  const backgroundOperations = new Set();
  let shuttingDown = false;

  async function ensureState(userId, presetId) {
    try {
      return (await repositories.state.getState(userId, presetId))
        || repositories.state.initializeRevisionZero(userId, presetId);
      } catch (error) {
        if (error?.code !== "MEMORY_V201_STATE_INVALID" || !repositories.state.getRawState || !repositories.audit.getRecoveryHead || !repositories.audit.listSnapshotsForRecovery) throw error;
        const rawState = await repositories.state.getRawState(userId, presetId);
        if (rawState && rawState.version !== SCHEMA_VERSION) {
          const cutoverError = new Error(`Memory state schema ${String(rawState.version)} cannot be opened by the 2.01-only runtime; run the Memory 2.01 data migration`);
          cutoverError.code = "MEMORY_V201_CUTOVER_REQUIRED";
          cutoverError.actualVersion = rawState.version;
          throw cutoverError;
        }
        const recovered = await stateRecovery.recoverScope(userId, presetId);
      if (!["healthy", "snapshot_restored", "events_replayed", "rebuilt"].includes(recovered.status)) throw new Error(`Memory state recovery did not complete: ${recovered.status}`);
      return recovered.state ?? repositories.state.getState(userId, presetId);
    }
  }

  function ensureScope({ userId, presetId } = {}) {
    return enqueueByKey(`${userId}:${presetId}`, () => ensureState(userId, presetId));
  }

  function runInBackground(work) {
    if (shuttingDown) {
      const error = new Error("Memory runtime is shutting down");
      error.code = "MEMORY_RUNTIME_SHUTTING_DOWN";
      const rejected = Promise.reject(error);
      if (typeof onBackgroundError === "function") rejected.catch(onBackgroundError);
      return rejected;
    }
    const promise = Promise.resolve().then(work);
    backgroundOperations.add(promise);
    void promise.finally(() => backgroundOperations.delete(promise)).catch(() => {});
    if (typeof onBackgroundError === "function") promise.catch(onBackgroundError);
    return promise;
  }

  async function shutdown() {
    if (shuttingDown) {
      while (backgroundOperations.size) await Promise.allSettled([...backgroundOperations]);
      await privacyDelete?.waitForIdle?.();
      return { status: "stopped" };
    }
    shuttingDown = true;
    stopTaskPolling();
    stopProjectionPolling();
    const initialization = providerInitialization;
    if (initialization) await Promise.allSettled([initialization]);
    while (backgroundOperations.size) await Promise.allSettled([...backgroundOperations]);
    await privacyDelete?.waitForIdle?.();
    return { status: "stopped" };
  }

  async function drainProjectionsNow(userId, presetId) {
    if (repositories.privacy?.hasIncompleteOperation
      && await repositories.privacy.hasIncompleteOperation(userId, presetId)) {
      return { privacy: { status: "skipped", reason: "privacy_delete_pending" } };
    }
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
    for (const projectionKey of Object.keys(projectionDrains)) {
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
        if (repositories.privacy?.hasIncompleteOperation && await repositories.privacy.hasIncompleteOperation(userId, presetId)) {
          return { status: "skipped", reason: "privacy_delete_pending" };
        }
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
        if (privacyDelete) await privacyDelete.reconcilePending();
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
    const key = `${userId}:${presetId}`;
    const active = activeRebuilds.get(key);
    if (active) return Promise.resolve({ status: "queued", operationId: active.operationId, deduplicated: true });
    const operationId = crypto.randomUUID();
    const promise = runInBackground(() => enqueueByKey(key, async () => {
      await initialize();
      const startedAt = performance.now();
      await ensureState(userId, presetId);
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, { reason });
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      metrics.observe("memory_rebuild_duration_ms", { reason, status: drained.status }, performance.now() - startedAt);
      const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId) : {};
      return { ...initialized, ...drained, projections };
    }));
    activeRebuilds.set(key, { operationId, promise });
    void promise.finally(() => {
      if (activeRebuilds.get(key)?.promise === promise) activeRebuilds.delete(key);
    }).catch(() => {});
    return Promise.resolve({ status: "queued", operationId, deduplicated: false });
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

  async function recoverPending({ requireComplete = false } = {}) {
    await initialize();
    const privacy = privacyDelete ? await privacyDelete.reconcilePending() : {};
    const rebuildBefore = await reconcileRebuilds();
    const recovered = await recovery.recoverPending();
    const rebuildAfter = await reconcileRebuilds();
    const projections = await reconcileProjections();
    if (requireComplete) {
      const pendingTasks = typeof repositories.runtime.listPendingTasks === "function"
        ? await repositories.runtime.listPendingTasks()
        : [];
      const issues = startupRecoveryIssues({ privacy, rebuildBefore, tasks: recovered, pendingTasks, rebuildAfter, projections });
      if (issues.length) {
        const error = new Error("Memory startup recovery did not complete");
        error.code = "MEMORY_STARTUP_RECOVERY_INCOMPLETE";
        error.detail = { issues };
        throw error;
      }
    }
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

  function getPrivacyOperation(userId, operationId) {
    return repositories.privacy?.getOperationById?.(userId, operationId) ?? Promise.resolve(null);
  }

  function hasIncompletePrivacyOperation(userId, presetId) {
    return repositories.privacy?.hasIncompleteOperation?.(userId, presetId) ?? Promise.resolve(false);
  }

  function markRecoveryNotificationsDelivered(ids) {
    return repositories.sidecars.markRecoveryNotificationsDelivered(ids);
  }

  function reconcilePrivacyDeletes() {
    return privacyDelete ? runInBackground(() => privacyDelete.reconcilePending()) : Promise.resolve({});
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
    getPrivacyOperation,
    hasIncompletePrivacyOperation,
    markRecoveryNotificationsDelivered,
    runRetentionScope,
    reconcileRebuilds,
    reconcilePrivacyDeletes,
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
    getProviderAdmissionSnapshot: () => admission.snapshot(),
    getMetricsSnapshot: () => metrics.snapshot(),
    recoverPending: (options) => runInBackground(() => recoverPending(options)),
    shutdown,
  });
}

module.exports = { createMemoryRuntime, createKeyedExecutor, startupRecoveryIssues };
