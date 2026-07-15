const ALLOWED_HEALTH_STATES = new Set(["starting", "recovering", "ready", "draining", "stopped", "failed"]);
const { isChatModelAllowed, isMemoryModelAllowed } = require("./chat/productionModelPolicy");

function createHealthState(initial = "starting") {
  let status = initial;
  if (!ALLOWED_HEALTH_STATES.has(status)) throw new Error(`Invalid health state: ${status}`);
  return Object.freeze({
    set(next) {
      if (!ALLOWED_HEALTH_STATES.has(next)) throw new Error(`Invalid health state: ${next}`);
      status = next;
      return status;
    },
    get status() { return status; },
    get ready() { return status === "ready"; },
    snapshot() { return { status, ready: status === "ready" }; },
  });
}

function installHealthEndpoints(app, health) {
  if (!app?.get || !app?.use || !health) throw new Error("Health endpoint dependencies are required");
  app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => {
    const status = health.ready ? 200 : 503;
    return res.status(status).json(health.snapshot());
  });
  app.use((req, res, next) => {
    if (health.ready) return next();
    res.set("Retry-After", "5");
    return res.status(503).json({ error: "Service unavailable", status: health.status });
  });
}

function validateProductionStartup({
  env = process.env,
  memoryEnabled,
  memoryModel,
  defaultChatProviderId,
  defaultChatModelId,
} = {}) {
  if (String(env.NODE_ENV || "").trim().toLowerCase() !== "production") return;
  if (memoryEnabled !== true || String(env.CHAT_MEMORY_V2_ENABLED || "").trim().toLowerCase() !== "true") {
    throw new Error("Production requires CHAT_MEMORY_V2_ENABLED=true; v2-off is not a rollback mode");
  }
  if (String(env.APP_REPLICA_COUNT || "").trim() !== "1") {
    throw new Error("Production requires APP_REPLICA_COUNT=1");
  }
  for (const key of ["LOG_DEBUG_FULL_ENABLED", "LOG_DEBUG_GIST_ENABLED"]) {
    if (String(env[key] || "").trim().toLowerCase() !== "false") {
      throw new Error(`Production requires ${key}=false`);
    }
  }
  if (!isMemoryModelAllowed(memoryModel, env)) {
    throw new Error(`Production Memory model is not in the independently verified context allowlist: ${String(memoryModel || "(empty)")}`);
  }
  if (!isChatModelAllowed(defaultChatProviderId, defaultChatModelId, env)) {
    throw new Error(`Production default chat model is not in the independently verified context allowlist: ${String(defaultChatProviderId || "(empty)")}/${String(defaultChatModelId || "(empty)")}`);
  }
}

function parseShutdownTimeout(value, fallback = 90_000) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 10 * 60_000) {
    throw new Error("SERVER_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 600000");
  }
  return parsed;
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    let server;
    try {
      server = app.listen(port, host);
    } catch (error) {
      reject(error);
      return;
    }
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function closeServer(server) {
  if (!server?.close) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, error }),
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

function createServerLifecycle({
  app,
  memoryRuntime,
  database,
  logger,
  health = createHealthState(),
  startCleanup = () => () => {},
  cancelInFlight = () => 0,
  waitForInFlight = async () => {},
  host = "127.0.0.1",
  port = 3000,
  shutdownTimeoutMs = 90_000,
  productionModels = {},
} = {}) {
  if (!app?.listen || !memoryRuntime || !database?.end || !logger) throw new Error("Server lifecycle dependencies are required");
  const timeoutMs = parseShutdownTimeout(shutdownTimeoutMs);
  let server = null;
  let stopCleanup = async () => {};
  let shutdownPromise = null;
  let stopRequested = false;
  let databaseClosed = false;

  function assertStartupActive() {
    if (!stopRequested) return;
    const error = new Error("Server startup was cancelled by shutdown");
    error.code = "SERVER_STARTUP_CANCELLED";
    throw error;
  }

  async function closeDatabase() {
    if (databaseClosed) return;
    databaseClosed = true;
    await database.end();
  }

  async function shutdown(reason = "shutdown", { failed = false } = {}) {
    if (shutdownPromise) return shutdownPromise;
    stopRequested = true;
    health.set("draining");
    shutdownPromise = (async () => {
      memoryRuntime.stopTaskPolling?.();
      memoryRuntime.stopProjectionPolling?.();
      const cancelledRequests = cancelInFlight(Object.assign(new Error("Service is shutting down"), {
        code: "SERVICE_SHUTTING_DOWN",
      }));
      const work = Promise.allSettled([
        closeServer(server),
        Promise.resolve(stopCleanup()),
        Promise.resolve(memoryRuntime.shutdown?.()),
        Promise.resolve(waitForInFlight()),
      ]);
      const graceful = await settleWithin(work, timeoutMs);
      const componentFailure = Array.isArray(graceful.value)
        ? graceful.value.find((result) => result.status === "rejected")?.reason
        : null;
      if (graceful.timedOut) {
        server?.closeAllConnections?.();
        logger.error("server_shutdown_timeout", { reason, timeoutMs, cancelledRequests });
      } else if (graceful.error || componentFailure) {
        logger.error("server_shutdown_failed", { reason, error: graceful.error || componentFailure, cancelledRequests });
      }
      const databaseResult = await settleWithin(closeDatabase(), Math.min(timeoutMs, 10_000));
      if (databaseResult.timedOut || databaseResult.error) {
        logger.error("database_shutdown_failed", {
          reason,
          timedOut: databaseResult.timedOut,
          error: databaseResult.error,
        });
      }
      const unsuccessful = graceful.timedOut || graceful.error || componentFailure || databaseResult.timedOut || databaseResult.error;
      health.set(failed || unsuccessful ? "failed" : "stopped");
      logger.info("server_stopped", { reason, graceful: !unsuccessful, cancelledRequests });
      return { status: health.status, graceful: !unsuccessful, cancelledRequests };
    })();
    return shutdownPromise;
  }

  async function start() {
    try {
      validateProductionStartup({ memoryEnabled: memoryRuntime.enabled, ...productionModels });
      health.set("starting");
      if (memoryRuntime.enabled) {
        await memoryRuntime.initialize();
        assertStartupActive();
        health.set("recovering");
        await memoryRuntime.recoverPending({ requireComplete: true });
        assertStartupActive();
        memoryRuntime.startTaskPolling();
        memoryRuntime.startProjectionPolling();
      }
      server = await listen(app, port, host);
      assertStartupActive();
      health.set("ready");
      const cleanup = await Promise.resolve(startCleanup());
      stopCleanup = typeof cleanup === "function" ? cleanup : async () => {};
      assertStartupActive();
      const address = server.address?.();
      logger.info("server_started", {
        port: typeof address === "object" && address ? address.port : port,
        host,
      });
      return server;
    } catch (error) {
      await shutdown("startup_failure", { failed: true });
      throw error;
    }
  }

  return Object.freeze({ start, shutdown, health, get server() { return server; } });
}

function installProcessHandlers({ lifecycle, logger, processRef = process } = {}) {
  if (!lifecycle?.shutdown || !logger || !processRef?.on) throw new Error("Process handler dependencies are required");
  let signalReceived = false;
  const handleSignal = (signal) => {
    if (signalReceived) {
      processRef.exitCode = 1;
      processRef.exit?.(1);
      return;
    }
    signalReceived = true;
    logger.info("server_shutdown_requested", { signal });
    void lifecycle.shutdown(signal).then((result) => {
      if (!result.graceful) processRef.exitCode = 1;
    }, (error) => {
      processRef.exitCode = 1;
      logger.error("server_shutdown_failed", { signal, error });
    });
  };
  const handleFatal = (event, error) => {
    processRef.exitCode = 1;
    logger.error(event, { error });
    void lifecycle.shutdown(event, { failed: true }).catch((shutdownError) => {
      logger.error("server_shutdown_failed", { event, error: shutdownError });
    });
  };
  const onSigterm = () => handleSignal("SIGTERM");
  const onSigint = () => handleSignal("SIGINT");
  const onUnhandledRejection = (reason) => handleFatal("unhandled_rejection", reason);
  const onUncaughtException = (error) => handleFatal("uncaught_exception", error);
  processRef.on("SIGTERM", onSigterm);
  processRef.on("SIGINT", onSigint);
  processRef.on("unhandledRejection", onUnhandledRejection);
  processRef.on("uncaughtException", onUncaughtException);
  return () => {
    processRef.removeListener?.("SIGTERM", onSigterm);
    processRef.removeListener?.("SIGINT", onSigint);
    processRef.removeListener?.("unhandledRejection", onUnhandledRejection);
    processRef.removeListener?.("uncaughtException", onUncaughtException);
  };
}

module.exports = {
  createHealthState,
  installHealthEndpoints,
  validateProductionStartup,
  parseShutdownTimeout,
  createServerLifecycle,
  installProcessHandlers,
};
