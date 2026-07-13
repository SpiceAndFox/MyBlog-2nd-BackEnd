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

function createDisabledRuntime() {
  const disabled = async () => ({ status: "disabled" });
  return Object.freeze({ enabled: false, processScope: disabled, rebuildScope: disabled, recoverPending: async () => [] });
}

function createMemoryRuntime({ config, repositories, providerAdapter, onBackgroundError } = {}) {
  if (!config?.enabled) return createDisabledRuntime();
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

  function processScope(userId, presetId) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await ensureState(userId, presetId);
      return pipeline.processScope(userId, presetId);
    }));
  }

  function rebuildScope(userId, presetId, { reason = "source_mutation" } = {}) {
    return runInBackground(() => enqueueByKey(`${userId}:${presetId}`, async () => {
      await ensureState(userId, presetId);
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, { reason });
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      return { ...initialized, ...drained };
    }));
  }

  return Object.freeze({
    enabled: true,
    processScope,
    rebuildScope,
    recoverPending: () => runInBackground(() => recovery.recoverPending()),
  });
}

module.exports = { createMemoryRuntime, createKeyedExecutor };
