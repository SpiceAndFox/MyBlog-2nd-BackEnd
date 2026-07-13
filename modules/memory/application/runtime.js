const { createObserver } = require("./observer");
const { createNormalWritePipeline } = require("./normalWritePipeline");
const { createMemoryRecovery } = require("./recovery");
const { createMemorySourceRebuild } = require("./sourceRebuild");
const { createMemoryProviderAdapter } = require("../infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("../infrastructure/providers/structuredTransportFactory");
const { loadProposerPrompt } = require("../prompts");

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
  async function mutateSourceAndRebuild(_userId, _presetId, { mutateSource } = {}) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
    const mutationResult = repositories?.withTransaction
      ? await repositories.withTransaction((client) => mutateSource(client))
      : await mutateSource(null);
    return { status: "memory_disabled", mutationResult };
  }
  return Object.freeze({ enabled: false, processScope: disabled, rebuildScope: disabled, mutateSourceAndRebuild, drainProjections: disabled, recoverPending: async () => [] });
}

function createMemoryRuntime({ config, repositories, providerAdapter, projectionDrains = {}, onBackgroundError } = {}) {
  if (!config?.enabled) return createDisabledRuntime(repositories);
  if (!repositories?.state || !repositories?.source || !repositories?.runtime) {
    throw new Error("Memory runtime repositories are required");
  }

  const enqueueByKey = createKeyedExecutor();
  const adapter = providerAdapter || createMemoryProviderAdapter({
    invokeStructured: createStructuredTransport(config.provider),
    promptLoader: loadProposerPrompt,
  });
  const observer = createObserver({
    sourceRepository: repositories.source,
    stateRepository: repositories.state,
    runtimeRepository: repositories.runtime,
    config,
  });
  const pipeline = createNormalWritePipeline({ observer, providerAdapter: adapter, repositories, config });
  const sourceRebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config });
  const recovery = createMemoryRecovery({ repositories, pipeline, enqueueByKey });

  async function ensureState(userId, presetId) {
    return (await repositories.state.getState(userId, presetId))
      || repositories.state.initializeRevisionZero(userId, presetId);
  }

  function runInBackground(work) {
    const promise = Promise.resolve().then(work);
    if (typeof onBackgroundError === "function") promise.catch(onBackgroundError);
    return promise;
  }

  async function drainProjectionsNow(userId, presetId) {
    const results = {};
    for (const projectionKey of ["rag", "recall"]) {
      const drain = projectionDrains[projectionKey];
      if (!drain?.drain) continue;
      results[projectionKey] = await drain.drain(userId, presetId);
    }
    return results;
  }

  function drainProjections(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, () => drainProjectionsNow(userId, presetId)));
  }

  function processScope(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await ensureState(userId, presetId);
      const memory = await pipeline.processScope(userId, presetId);
      const projections = await drainProjectionsNow(userId, presetId);
      return { memory, projections };
    }));
  }

  function rebuildScope(userId, presetId, { reason = "source_mutation" } = {}) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await ensureState(userId, presetId);
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, { reason });
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      const projections = drained.status === "completed" ? await drainProjectionsNow(userId, presetId) : {};
      return { ...initialized, ...drained, projections };
    }));
  }

  async function mutateSourceAndRebuild(userId, presetId, { mutateSource, purgeDerived = null, reason = "source_mutation" } = {}) {
    if (typeof mutateSource !== "function") throw new Error("mutateSource callback is required");
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
    const recovered = await recovery.recoverPending();
    if (typeof repositories.state.listScopes === "function") {
      const scopes = await repositories.state.listScopes();
      for (const scope of scopes) {
        await enqueueByKey(`${scope.user_id}:${scope.preset_id}`, () => drainProjectionsNow(scope.user_id, scope.preset_id));
      }
    }
    return recovered;
  }

  return Object.freeze({
    enabled: true,
    processScope,
    rebuildScope,
    mutateSourceAndRebuild,
    drainProjections,
    recoverPending: () => runInBackground(recoverPending),
  });
}

module.exports = { createMemoryRuntime, createKeyedExecutor };
