function createChatMemoryRuntime({
  config,
  recentWindowMaxChars,
  logger,
  memoryModule,
  ragProjectionAdapter,
  privacyStores = [],
  enqueueByKey,
} = {}) {
  if (!config || typeof config !== "object") throw new Error("Memory runtime config is required");
  if (!logger?.error) throw new Error("Memory runtime logger is required");
  if (!memoryModule?.createRuntime || !memoryModule?.createContextAssembly || !memoryModule?.createProjectionDrain) {
    throw new Error("An explicitly created Memory module is required");
  }

  const projectionDrains = config.enabled
    ? { rag: memoryModule.createProjectionDrain("rag", ragProjectionAdapter) }
    : {};
  const runtime = memoryModule.createRuntime({
    config,
    projectionDrains,
    privacyStores,
    enqueueByKey,
    onBackgroundError: (error) => logger.error("memory_v2_background_failed", { error }),
  });
  const assembleContext = config.enabled
    ? memoryModule.createContextAssembly({
      runtime,
      config,
      recentWindowMaxChars,
      onBackgroundError: (error) => logger.error("memory_v2_housekeeping_failed", { error }),
    })
    : async () => {
      throw new Error("Memory context assembly is unavailable while Memory v2 is disabled");
    };

  return Object.freeze({ ...runtime, assembleContext });
}

let configuredRuntime = null;

function configureChatMemoryRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") throw new Error("Chat Memory runtime is required");
  configuredRuntime = runtime;
  return configuredRuntime;
}

function getChatMemoryRuntime() {
  if (!configuredRuntime) {
    throw new Error("Chat Memory runtime is not configured; create it in app/composition before use");
  }
  return configuredRuntime;
}

const memoryRuntime = {
  get enabled() { return getChatMemoryRuntime().enabled; },
};

for (const method of [
  "initialize",
  "recoverPending",
  "startTaskPolling",
  "startProjectionPolling",
  "stopTaskPolling",
  "stopProjectionPolling",
  "shutdown",
  "processScope",
  "rebuildScope",
  "getPrivacyOperation",
  "privacyHardDelete",
  "mutateSourceAndRebuild",
  "resumeTarget",
  "assembleContext",
  "markRecoveryNotificationsDelivered",
]) {
  memoryRuntime[method] = (...args) => {
    const runtime = getChatMemoryRuntime();
    if (typeof runtime[method] !== "function") throw new Error(`Memory runtime method is unavailable: ${method}`);
    return runtime[method](...args);
  };
}

memoryRuntime.createChatMemoryRuntime = createChatMemoryRuntime;
memoryRuntime.configureChatMemoryRuntime = configureChatMemoryRuntime;
memoryRuntime.getChatMemoryRuntime = getChatMemoryRuntime;

module.exports = memoryRuntime;
