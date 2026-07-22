const { createMemoryInfrastructureRepositories } = require("./infrastructure/repositories");
const { createMemoryRuntime } = require("./application/runtime");
const { createMemoryContextAssembly } = require("./application/contextAssembly");
const { createProjectionDrain } = require("./application/projectionDrain");

function createRepositorySet({ database, transactionExecutor, sourceReader, userTimeZoneReader } = {}) {
  if (!sourceReader?.getByIds || !sourceReader?.listUpTo || !sourceReader?.getBoundary) {
    throw new Error("Memory module requires an injected Chat raw source reader");
  }
  if (!userTimeZoneReader?.getTimeZone) {
    throw new Error("Memory module requires an injected Auth User time-zone reader");
  }
  const coreRepositories = createMemoryInfrastructureRepositories({ database, transactionExecutor });
  return Object.freeze({
    ...coreRepositories,
    source: sourceReader,
    userTimeZones: userTimeZoneReader,
  });
}

function createMemoryModule({ database, transactionExecutor, sourceReader, userTimeZoneReader } = {}) {
  const repositories = createRepositorySet({ database, transactionExecutor, sourceReader, userTimeZoneReader });

  function createRuntime(options = {}) {
    return createMemoryRuntime({ ...options, repositories });
  }

  function createContextAssembly({ runtime, ...options } = {}) {
    if (!runtime || typeof runtime !== "object") {
      throw new Error("Memory context assembly requires an explicitly created runtime");
    }
    return createMemoryContextAssembly({
      ...options,
      repositories,
      scheduleHousekeeping: options.scheduleHousekeeping || runtime.scheduleHousekeeping,
      scheduleStateRecovery: options.scheduleStateRecovery || runtime.scheduleStateRecovery,
      ensureState: options.ensureState || runtime.ensureScope,
      metrics: options.metrics || runtime.metrics,
    });
  }

  function createBoundProjectionDrain(projectionKey, adapter) {
    return createProjectionDrain({ repositories, projectionKey, adapter });
  }

  return Object.freeze({
    createContextAssembly,
    createProjectionDrain: createBoundProjectionDrain,
    createRuntime,
  });
}

module.exports = { createMemoryModule, createRepositorySet };
