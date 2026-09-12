const crypto = require("node:crypto");
const { LIBRARIAN_TARGET_KEY, SCHEMA_VERSION } = require("../contracts");
const { createObserver } = require("./observer");
const { createNormalWritePipeline } = require("./normalWritePipeline");
const { createMemoryRecovery } = require("./recovery");
const { createMemoryHousekeeping } = require("./housekeeping");
const { createMemorySourceRebuild } = require("./sourceRebuild");
const { createMemoryStateRecovery } = require("./stateRecovery");
const { createMemoryProviderAdapter } = require("../infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("../infrastructure/providers/structuredTransportFactory");
const { loadProposerPrompt } = require("../prompts");
const { createMemoryMetrics } = require("./metrics");
const { createDiagnosticProjection } = require("./diagnosticProjection");
const { createPrivacyHardDelete } = require("./privacyHardDelete");
const { createMemoryRetention } = require("./retention");
const { createProviderAdmission, admissionControlledAdapter } = require("./providerAdmission");
const { createProviderRequestControl } = require("./providerRequestRecovery");
const { createProviderHealth } = require("../../../shared/observability/providerHealth");
const { createRetryBudget } = require("./retryBudget");
const { createMemoryRuntimeHealth } = require("./runtimeHealth");
const { createMemoryLibrarian } = require("./librarian");
const { createMemoryWorkCoordinator } = require("./workCoordinator");

const MAX_BACKGROUND_FAILURE_REASON_CHARS = 200;

function backgroundFailureReason(error, fallback) {
  return String(error?.code || error?.name || fallback).slice(0, MAX_BACKGROUND_FAILURE_REASON_CHARS);
}

function createKeyedExecutor() {
  const lanes = new Map();
  return function enqueueByKey(key, work) {
    const previous = lanes.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    lanes.set(key, current);
    const release = () => {
      if (lanes.get(key) === current) lanes.delete(key);
    };
    void current.then(release, release);
    return current;
  };
}

function startupRecoveryIssues({
  privacy = {},
  rebuildBefore = {},
  tasks = [],
  pendingTasks = [],
  rebuildAfter = {},
  projections = {},
} = {}) {
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
  const failedTaskStatuses = new Set([
    "dispatch_failed",
    "failed",
    "queued",
    "retry_wait",
    "incomplete",
    "stale",
    "error",
  ]);
  for (const result of tasks || []) {
    if (result?.targetKey === LIBRARIAN_TARGET_KEY) continue;
    const status = String(result?.status || "unknown");
    if (failedTaskStatuses.has(status)) issues.push({ kind: "task", taskId: result?.taskId ?? null, status });
  }
  for (const task of pendingTasks || []) {
    if ((task?.target_key ?? task?.targetKey) === LIBRARIAN_TARGET_KEY) continue;
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
        ? await repositories.withTransaction(async (client) => {
            await repositories.sourceWriteGuard.lockScope(_userId, _presetId, { client });
            return mutateSource(client);
          })
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
  function lockSourceWriteGuard(userId, presetId, { client } = {}) {
    return repositories.sourceWriteGuard.lockAndRead(userId, presetId, { client });
  }
  return Object.freeze({
    enabled: false,
    ensureScope: disabled,
    processScope: disabled,
    rebuildScope: disabled,
    mutateSourceAndRebuild,
    privacyHardDelete,
    lockSourceWriteGuard,
    getPrivacyOperation: (userId, operationId) =>
      repositories?.privacy?.getOperationById?.(userId, operationId) ?? Promise.resolve(null),
    hasIncompletePrivacyOperation: (userId, presetId) =>
      repositories?.privacy?.hasIncompleteOperation?.(userId, presetId) ?? Promise.resolve(false),
    markRecoveryNotificationsDelivered: (ids) =>
      repositories?.sidecars?.markRecoveryNotificationsDelivered?.(ids) ?? Promise.resolve([]),
    runRetentionScope: disabled,
    runLibrarian: disabled,
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
    getHealthSnapshot: async () => ({
      provider: {
        name: "memory",
        status: "disabled",
        available: false,
        failureCount: 0,
        reason: "memory_disabled",
        lastFailureAt: null,
        lastSuccessAt: null,
        nextRetryAt: null,
        retryMode: null,
      },
      scope: null,
    }),
    getProviderHealthSnapshot: () => Object.freeze({
      name: "memory",
      status: "disabled",
      available: false,
      failureCount: 0,
      reason: "memory_disabled",
      lastFailureAt: null,
      lastSuccessAt: null,
      nextRetryAt: null,
      retryMode: null,
    }),
    retryProviderNow: disabled,
    recoverPending: async () => ({
      privacy: {},
      rebuildBefore: {},
      tasks: [],
      pendingTasks: [],
      rebuildAfter: {},
      projections: {},
      issues: [],
    }),
    shutdown: async () => {
      stopProjectionPolling();
      stopTaskPolling();
      await privacyDelete?.waitForIdle?.();
      return { status: "stopped" };
    },
  });
}

function createMemoryRuntime({
  config,
  repositories,
  providerAdapter,
  privacyStores = [],
  metrics = createMemoryMetrics(),
  onBackgroundError,
  enqueueByKey: sharedEnqueueByKey,
} = {}) {
  const sourceQueue = sharedEnqueueByKey || createKeyedExecutor();
  if (!config?.enabled) return createDisabledRuntime(repositories, privacyStores, sourceQueue);
  const workCoordinator = createMemoryWorkCoordinator({ enqueueMutation: sourceQueue });
  const enqueueByKey = workCoordinator.enqueue;
  if (!repositories?.state || !repositories?.source || !repositories?.runtime) {
    throw new Error("Memory runtime repositories are required");
  }
  const admission = createProviderAdmission(config.admission);
  const rawInvokeStructured = providerAdapter ? null : createStructuredTransport(config.provider);
  const providerHealth = createProviderHealth({ name: "memory" });
  const retryBudget = createRetryBudget();
  const rawAdapter =
    providerAdapter ||
    createMemoryProviderAdapter({ invokeStructured: rawInvokeStructured, promptLoader: loadProposerPrompt,
      requestControl: createProviderRequestControl({ health: providerHealth, retryBudget, config }) });
  const adapter = admissionControlledAdapter(rawAdapter, admission);
  const observer = createObserver({
    sourceRepository: repositories.source,
    stateRepository: repositories.state,
    runtimeRepository: repositories.runtime,
    config,
    metrics,
  });
  const pipeline = createNormalWritePipeline({ observer, providerAdapter: adapter, repositories, config, metrics, retryBudget });
  let sourceRebuild;
  const librarian = createMemoryLibrarian({
    retryBudget,
    repositories,
    providerAdapter: adapter,
    config,
    metrics,
    drainBarrier: (userId, presetId, options) => sourceRebuild.forceDrainTargetsTo(userId, presetId, options),
  });
  sourceRebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, librarian, config });
  const privacyDelete = repositories.privacy
    ? createPrivacyHardDelete({ repositories, sourceRebuild, stores: privacyStores, enqueueByKey,
        enqueueMutation: workCoordinator.mutate,
        ensureState: (userId, presetId) => ensureScope({ userId, presetId }), onBackgroundError })
    : null;
  const stateRecovery = createMemoryStateRecovery({ repositories, sourceRebuild });
  const recovery = createMemoryRecovery({
    repositories,
    pipeline,
    librarianPipeline: librarian,
    enqueueByKey,
    metrics,
    onDispatchError: onBackgroundError,
  });
  const housekeeping = createMemoryHousekeeping({ repositories, config, enqueueByKey });
  const diagnosticProjection = repositories.diagnosticProjection ? createDiagnosticProjection({ repositories }) : null;
  const retention = config.retention ? createMemoryRetention({ repositories, config, diagnosticProjection }) : null;
  let projectionPollTimer = null;
  let projectionPollRunning = false;
  let taskPollTimer = null;
  let taskPollRunning = false;
  const activeRebuilds = new Map();
  const backgroundOperations = new Set();
  let shuttingDown = false;

  async function ensureState(userId, presetId, { signal } = {}) {
    try {
      return (
        (await repositories.state.getState(userId, presetId)) ||
        repositories.state.initializeRevisionZero(userId, presetId)
      );
    } catch (error) {
      if (
        error?.code !== "MEMORY_V201_STATE_INVALID" ||
        !repositories.state.getRawState ||
        !repositories.audit.getRecoveryHead ||
        !repositories.audit.listSnapshotsForRecovery
      )
        throw error;
      const rawState = await repositories.state.getRawState(userId, presetId);
      if (rawState && rawState.version !== SCHEMA_VERSION) {
        const cutoverError = new Error(
          `Memory state schema ${String(rawState.version)} cannot be opened by the 2.01-only runtime; run the Memory 2.01 data migration`,
        );
        cutoverError.code = "MEMORY_V201_CUTOVER_REQUIRED";
        cutoverError.actualVersion = rawState.version;
        throw cutoverError;
      }
      // We already hold the Memory lane. Schedule, but never await, the joint
      // mutation barrier here: it must first wait for this job to leave.
      if (!signal?.aborted) void scheduleStateRecovery({ userId, presetId }).catch(() => {});
      return null;
    }
  }

  function ensureScope({ userId, presetId } = {}) {
    // Context assembly already runs inside a chat send. Initialization is a
    // short idempotent transaction; never re-enter that lane or await a model.
    return repositories.state.getState(userId, presetId).then(state =>
      state || repositories.state.initializeRevisionZero(userId, presetId));
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
    await workCoordinator.shutdown();
    while (backgroundOperations.size) await Promise.allSettled([...backgroundOperations]);
    await privacyDelete?.waitForIdle?.();
    return { status: "stopped" };
  }

  async function drainProjectionsNow(userId, presetId, { signal } = {}) {
    if (signal?.aborted) return {};
    if (
      repositories.privacy?.hasIncompleteOperation &&
      (await repositories.privacy.hasIncompleteOperation(userId, presetId))
    ) {
      return { privacy: { status: "skipped", reason: "privacy_delete_pending" } };
    }
    const results = {};
    if (diagnosticProjection) {
      const startedAt = performance.now();
      try {
        results.diagnostics = await diagnosticProjection.syncScope(userId, presetId);
        metrics.observe(
          "memory_projection_duration_ms",
          { projectionKey: "diagnostics", status: results.diagnostics.status },
          performance.now() - startedAt,
        );
      } catch (error) {
        results.diagnostics = {
          status: "failed",
          reason: backgroundFailureReason(error, "projection_failed"),
        };
        if (!error?.suppressed) onBackgroundError?.(error);
        metrics.observe(
          "memory_projection_duration_ms",
          { projectionKey: "diagnostics", status: "failed" },
          performance.now() - startedAt,
        );
      }
    }
    return results;
  }

  function drainProjections(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, options => drainProjectionsNow(userId, presetId, options)));
  }

  async function reconcileProjections() {
    if (typeof repositories.state.listInitializedScopes !== "function") return {};
    const scopes = await repositories.state.listInitializedScopes();
    const results = {};
    for (const scope of scopes) {
      const userId = Number(scope.userId ?? scope.user_id);
      const presetId = String(scope.presetId ?? scope.preset_id ?? "").trim();
      if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) continue;
      results[`${userId}:${presetId}`] = await enqueueByKey(`${userId}:${presetId}`, options =>
        drainProjectionsNow(userId, presetId, options),
      );
    }
    return results;
  }

  async function reconcileRebuilds({ resumeHalted = false, selectedScope = null } = {}) {
    if (typeof repositories.state.listInitializedScopes !== "function") return {};
    const scopes = await repositories.state.listInitializedScopes();
    const results = {};
    for (const scope of scopes) {
      const userId = Number(scope.userId ?? scope.user_id);
      const presetId = String(scope.presetId ?? scope.preset_id ?? "").trim();
      if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) continue;
      if (selectedScope
        && (Number(selectedScope.userId) !== userId || String(selectedScope.presetId) !== presetId)) continue;
      results[`${userId}:${presetId}`] = await enqueueByKey(`${userId}:${presetId}`, async ({ signal }) => {
        if (
          repositories.privacy?.hasIncompleteOperation &&
          (await repositories.privacy.hasIncompleteOperation(userId, presetId))
        ) {
          return { status: "skipped", reason: "privacy_delete_pending" };
        }
        const state = await ensureState(userId, presetId, { signal });
        if (!state) return { status: "skipped", reason: "state_recovery_pending" };
        const statuses = await repositories.runtime.getTargetStatuses(userId, presetId);
        const rebuilding = statuses.filter((row) => {
          const boundary = row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId;
          return (
            Number(row.source_generation ?? row.sourceGeneration) === state.meta.sourceGeneration &&
            boundary !== null &&
            boundary !== undefined
          );
        });
        if (!rebuilding.length) return { status: "skipped", reason: "not_rebuilding" };
        const halted = rebuilding.filter((row) => row.status === "halted");
        if (halted.length && !resumeHalted) {
          return {
            status: "incomplete",
            reason: "provider_halted",
            targets: halted.map((row) => row.target_key ?? row.targetKey),
          };
        }
        const boundaries = [
          ...new Set(rebuilding.map((row) => Number(row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId))),
        ];
        if (boundaries.length !== 1) throw new Error("Memory rebuilding targets have inconsistent boundaries");
        return sourceRebuild.forceDrainTo(userId, presetId, {
          sourceGeneration: state.meta.sourceGeneration,
          boundaryMessageId: boundaries[0],
          resumeHalted,
          signal,
        });
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
      runInBackground(reconcileProjections).finally(() => {
        projectionPollRunning = false;
      });
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
      }).finally(() => {
        taskPollRunning = false;
      });
    };
    taskPollTimer = setInterval(tick, intervalMs);
    taskPollTimer.unref?.();
    return stopTaskPolling;
  }

  async function processScopeNow(userId, presetId, { signal }) {
    if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
      return { status: "skipped", reason: "privacy_delete_pending" };
    }
    const state = await ensureState(userId, presetId, { signal });
    if (!state) return { status: "skipped", reason: "state_recovery_pending" };
    let librarianResult;
    try {
      librarianResult = await librarian.runScheduled(userId, presetId, { signal });
    } catch (error) {
      librarianResult = { status: "failed", reason: backgroundFailureReason(error, "librarian_failed") };
      metrics.increment("memory_librarian_background_errors_total", {});
      onBackgroundError?.(error);
    }
    if (signal.aborted) return { status: "interrupted", reason: "cancelled" };
    const memory = await pipeline.processScope(userId, presetId, { signal });
    const projections = await drainProjectionsNow(userId, presetId, { signal });
    return { memory, librarian: librarianResult, projections };
  }

  const pendingScopes = new Map();
  function processScope(userId, presetId) {
    const key = `${userId}:${presetId}`;
    const pending = pendingScopes.get(key);
    if (pending) { pending.dirty = true; return pending.promise; }
    const entry = { dirty: true };
    entry.promise = runInBackground(() =>
      enqueueByKey(key, async ({ signal }) => {
        let result;
        while (entry.dirty && !signal.aborted) {
          entry.dirty = false;
          result = await processScopeNow(userId, presetId, { signal });
        }
        return signal.aborted ? { status: "interrupted", reason: "cancelled" } : result;
      }),
    );
    pendingScopes.set(key, entry);
    const release = () => { if (pendingScopes.get(key) === entry) pendingScopes.delete(key); };
    void entry.promise.then(release, release);
    return entry.promise;
  }

  function rebuildScope(userId, presetId, { reason = "manual_repair" } = {}) {
    const key = `${userId}:${presetId}`;
    const active = activeRebuilds.get(key);
    if (active) return Promise.resolve({ status: "queued", operationId: active.operationId, deduplicated: true });
    const operationId = crypto.randomUUID();
    const promise = runInBackground(() =>
      enqueueByKey(key, async ({ signal }) => {
        const startedAt = performance.now();
        const state = await ensureState(userId, presetId, { signal });
        if (!state) return { status: "skipped", reason: "state_recovery_pending" };
        const statuses = await repositories.runtime.getTargetStatuses(userId, presetId);
        const rebuilding = statuses.filter((row) => {
          const boundary = row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId;
          return Number(row.source_generation ?? row.sourceGeneration) === state.meta.sourceGeneration
            && boundary !== null
            && boundary !== undefined;
        });
        if (!rebuilding.length) {
          return {
            status: "not_required",
            sourceGeneration: state.meta.sourceGeneration,
            reason: "no_resumable_rebuild",
          };
        }
        const boundaries = [...new Set(rebuilding.map((row) => (
          Number(row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId)
        )))];
        if (boundaries.length !== 1) throw new Error("Memory rebuilding targets have inconsistent boundaries");
        const initialized = {
          sourceGeneration: state.meta.sourceGeneration,
          revision: state.meta.revision,
          boundaryMessageId: boundaries[0],
          resumed: true,
        };
        const drained = await sourceRebuild.forceDrainTo(userId, presetId, {
          ...initialized,
          resumeHalted: true,
          signal,
        });
        metrics.observe(
          "memory_rebuild_duration_ms",
          { reason, status: drained.status },
          performance.now() - startedAt,
        );
        const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId, { signal }) : {};
        return { ...initialized, ...drained, projections };
      }),
    );
    activeRebuilds.set(key, { operationId, promise });
    void promise
      .finally(() => {
        if (activeRebuilds.get(key)?.promise === promise) activeRebuilds.delete(key);
      })
      .catch(() => {});
    return Promise.resolve({ status: "queued", operationId, deduplicated: false });
  }

  async function mutateSourceAndRebuild(
    userId,
    presetId,
    { mutateSource, purgeDerived = null, reason = "source_mutation", affectedFromMessageId = null, sourceAlreadyExcluded = false } = {},
  ) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
    const initialized = await workCoordinator.mutate(`${userId}:${presetId}`, async () => {
      if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
        throw Object.assign(new Error("Privacy operation is still in progress"), { status: 409, code: "MEMORY_PRIVACY_OPERATION_PENDING" });
      }
      await ensureScope({ userId, presetId });
      return sourceRebuild.initializeGeneration(userId, presetId, {
        mutateSource,
        purgeDerived,
        reason,
        affectedFromMessageId,
        sourceAlreadyExcluded,
      });
    });
    runInBackground(() =>
      enqueueByKey(`${userId}:${presetId}`, async ({ signal }) => {
        const drained = initialized.rebuildRequired === false ? { status: "completed" }
          : await sourceRebuild.forceDrainTo(userId, presetId, { ...initialized, signal });
        const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId, { signal }) : {};
        return { ...drained, projections };
      }),
    );
    return { status: initialized.rebuildRequired === false ? "completed" : "rebuilding", ...initialized };
  }

  async function recoverPending() {
    const privacy = privacyDelete ? await privacyDelete.reconcilePending() : {};
    const rebuildBefore = await reconcileRebuilds();
    const recovered = await recovery.recoverPending();
    const rebuildAfter = await reconcileRebuilds();
    const projections = await reconcileProjections();
    const pendingTasks =
      typeof repositories.runtime.listPendingTasks === "function"
        ? await repositories.runtime.listPendingTasks()
        : [];
    const report = {
      privacy,
      rebuildBefore,
      tasks: recovered,
      pendingTasks,
      rebuildAfter,
      projections,
    };
    return { ...report, issues: startupRecoveryIssues(report) };
  }

  function scheduleHousekeeping({ userId, presetId, requestNow } = {}) {
    return runInBackground(() => housekeeping.runScope(userId, presetId, { requestNow }));
  }

  const pendingStateRecoveries = new Map();
  function scheduleStateRecovery({ userId, presetId } = {}) {
    const key = `${userId}:${presetId}`;
    if (pendingStateRecoveries.has(key)) return pendingStateRecoveries.get(key);
    const promise = runInBackground(async () => {
      const initialized = await workCoordinator.mutate(key, async () => {
        if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
          return { status: "skipped", reason: "privacy_delete_pending" };
        }
        return stateRecovery.prepareScopeRecovery(userId, presetId);
      });
      if (initialized.status !== "rebuild_initialized") return initialized;
      return enqueueByKey(key, async options => {
        if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
          return { status: "skipped", reason: "privacy_delete_pending" };
        }
        return stateRecovery.drainPreparedRecovery(userId, presetId, initialized, options);
      });
    });
    pendingStateRecoveries.set(key, promise);
    const release = () => { if (pendingStateRecoveries.get(key) === promise) pendingStateRecoveries.delete(key); };
    void promise.then(release, release);
    return promise;
  }

  async function resumeTarget(userId, presetId, targetKey) {
    retryBudget.resetScope(userId, presetId, targetKey);
    const result = await enqueueByKey(`${userId}:${presetId}`, () =>
      recovery.resumeTarget(userId, presetId, targetKey, { run: false }),
    );
    // The resumed task must run after the preparation transaction releases the
    // scope lane. Dispatching it from inside that lane would self-deadlock.
    const recovered = await recovery.recoverPending();
    return { ...result, recovered };
  }

  const runtimeHealth = createMemoryRuntimeHealth({
    config,
    repositories,
    providerHealth,
    resetRetryBudget: (userId, presetId) => retryBudget.resetScope(userId, presetId),
    reconcileRebuilds,
    recovery,
  });

  function privacyHardDelete(userId, presetId, options) {
    if (!privacyDelete) throw new Error("Memory privacy hard delete is unavailable");
    return privacyDelete.execute(userId, presetId, options);
  }

  function lockSourceWriteGuard(userId, presetId, { client } = {}) {
    return repositories.sourceWriteGuard.lockAndRead(userId, presetId, { client });
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

  function runLibrarian(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async options => {
      if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
        return { status: "skipped", reason: "privacy_delete_pending" };
      }
      return librarian.runManual(userId, presetId, options);
    }));
  }

  return Object.freeze({
    enabled: true,
    ensureScope,
    processScope,
    rebuildScope,
    mutateSourceAndRebuild,
    privacyHardDelete,
    lockSourceWriteGuard,
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
    runLibrarian,
    getHealthSnapshot: runtimeHealth.getHealthSnapshot,
    metrics,
    getProviderAdmissionSnapshot: () => admission.snapshot(),
    getProviderHealthSnapshot: () => providerHealth.snapshot(),
    retryProviderNow: runtimeHealth.retryProviderNow,
    getMetricsSnapshot: () => metrics.snapshot(),
    recoverPending: (options) => runInBackground(() => recoverPending(options)),
    shutdown,
  });
}

module.exports = { createMemoryRuntime, createKeyedExecutor, startupRecoveryIssues };
