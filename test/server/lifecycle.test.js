const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const {
  createHealthState,
  installHealthEndpoints,
  validateProductionStartup,
  parseShutdownTimeout,
  createServerLifecycle,
  installProcessHandlers,
} = require("../../services/serverLifecycle");
const {
  loadProductionModelPolicy,
  isChatModelAllowed,
  isMemoryModelAllowed,
} = require("../../modules/chat");

function logger(events = []) {
  return {
    info(message, detail) { events.push(["info", message, detail]); },
    error(message, detail) { events.push(["error", message, detail]); },
  };
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

async function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("health endpoints keep business traffic closed until readiness is established", async () => {
  const app = express();
  const health = createHealthState();
  installHealthEndpoints(app, health);
  app.get("/business", (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  const { port } = server.address();
  try {
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    const notReady = await fetch(`http://127.0.0.1:${port}/health/ready`);
    const blocked = await fetch(`http://127.0.0.1:${port}/business`);
    assert.equal(live.status, 200);
    assert.equal(notReady.status, 503);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get("retry-after"), "5");

    health.set("ready");
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    const business = await fetch(`http://127.0.0.1:${port}/business`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await business.json(), { ok: true });

    health.set("draining");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/business`)).status, 503);
  } finally {
    await close(server);
  }
});

test("server listens only after strict Memory recovery and drains all workers before closing the database", async () => {
  const events = [];
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const app = express();
  const health = createHealthState();
  installHealthEndpoints(app, health);
  const memoryRuntime = {
    enabled: true,
    async initialize() { events.push("memory:initialize"); },
    async recoverPending(options) {
      events.push(["memory:recover", options]);
      await recoveryGate;
    },
    startTaskPolling() { events.push("tasks:start"); },
    startProjectionPolling() { events.push("projections:start"); },
    stopTaskPolling() { events.push("tasks:stop"); },
    stopProjectionPolling() { events.push("projections:stop"); },
    async shutdown() { events.push("memory:shutdown"); },
  };
  const lifecycle = createServerLifecycle({
    app,
    memoryRuntime,
    database: { async end() { events.push("database:end"); } },
    logger: logger(),
    health,
    port: 0,
    shutdownTimeoutMs: 2_000,
    startCleanup() {
      events.push("cleanup:start");
      return async () => { events.push("cleanup:stop"); };
    },
    cancelInFlight() { events.push("requests:cancel"); return 2; },
    async waitForInFlight() { events.push("requests:idle"); },
  });

  const starting = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.server, null);
  assert.equal(health.status, "recovering");
  releaseRecovery();
  const server = await starting;
  assert.equal(health.status, "ready");
  assert.deepEqual(events.slice(0, 5), [
    "memory:initialize",
    ["memory:recover", { requireComplete: true }],
    "tasks:start",
    "projections:start",
    "cleanup:start",
  ]);
  assert.ok(server.listening);

  const result = await lifecycle.shutdown("test");
  assert.deepEqual(result, { status: "stopped", graceful: true, cancelledRequests: 2 });
  assert.equal(health.status, "stopped");
  assert.ok(events.indexOf("memory:shutdown") < events.indexOf("database:end"));
  assert.ok(events.indexOf("cleanup:stop") < events.indexOf("database:end"));
  assert.ok(events.indexOf("requests:idle") < events.indexOf("database:end"));
});

test("production startup fails closed unless v2, single replica, and raw-log settings are explicit", () => {
  const valid = {
    NODE_ENV: "production",
    CHAT_MEMORY_V2_ENABLED: "true",
    APP_REPLICA_COUNT: "1",
    LOG_DEBUG_FULL_ENABLED: "false",
    LOG_DEBUG_GIST_ENABLED: "false",
    CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({
      chat: { deepseek: ["deepseek-v4-flash"] },
      memory: ["deepseek-v4-flash"],
    }),
  };
  const models = {
    memoryModel: "deepseek-v4-flash",
    defaultChatProviderId: "deepseek",
    defaultChatModelId: "deepseek-v4-flash",
  };
  assert.doesNotThrow(() => validateProductionStartup({ env: valid, memoryEnabled: true, ...models }));
  assert.throws(() => validateProductionStartup({ env: { ...valid, CHAT_MEMORY_V2_ENABLED: "false" }, memoryEnabled: false, ...models }), /v2-off/);
  assert.throws(() => validateProductionStartup({ env: { ...valid, APP_REPLICA_COUNT: "2" }, memoryEnabled: true, ...models }), /APP_REPLICA_COUNT=1/);
  assert.throws(() => validateProductionStartup({ env: { ...valid, LOG_DEBUG_FULL_ENABLED: "true" }, memoryEnabled: true, ...models }), /LOG_DEBUG_FULL_ENABLED=false/);
  assert.throws(() => validateProductionStartup({ env: { ...valid, LOG_DEBUG_GIST_ENABLED: "" }, memoryEnabled: true, ...models }), /LOG_DEBUG_GIST_ENABLED=false/);
  assert.throws(() => validateProductionStartup({ env: valid, memoryEnabled: true, ...models, memoryModel: "unverified" }), /Memory model is not/);
  assert.throws(() => validateProductionStartup({ env: valid, memoryEnabled: true, ...models, defaultChatModelId: "unverified" }), /default chat model is not/);
  assert.throws(() => validateProductionStartup({
    env: { ...valid, CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: "{}" },
    memoryEnabled: true,
    ...models,
  }), /ALLOWLIST|allowlist/);
});

test("shutdown timeout has bounded and validated deployment configuration", () => {
  assert.equal(parseShutdownTimeout(undefined), 90_000);
  assert.equal(parseShutdownTimeout("120000"), 120_000);
  assert.throws(() => parseShutdownTimeout("999"), /between 1000 and 600000/);
  assert.throws(() => parseShutdownTimeout("invalid"), /between 1000 and 600000/);
});

test("production context model policy is explicit and enforced for chat and Memory independently", () => {
  const env = {
    NODE_ENV: "production",
    CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON: JSON.stringify({
      chat: { deepseek: ["deepseek-v4-flash", "deepseek-v4-flash"] },
      memory: ["deepseek-v4-flash"],
    }),
  };
  assert.deepEqual(loadProductionModelPolicy(env), {
    chat: { deepseek: ["deepseek-v4-flash"] },
    memory: ["deepseek-v4-flash"],
  });
  assert.equal(isChatModelAllowed("deepseek", "deepseek-v4-flash", env), true);
  assert.equal(isChatModelAllowed("deepseek", "unverified", env), false);
  assert.equal(isMemoryModelAllowed("deepseek-v4-flash", env), true);
  assert.equal(isMemoryModelAllowed("unverified", env), false);
  assert.equal(isChatModelAllowed("anything", "anything", { NODE_ENV: "test" }), true);
});

test("fatal process events trigger shutdown and retain a non-zero exit status", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = 0;
  const events = [];
  const lifecycle = {
    async shutdown(reason, options) { events.push([reason, options]); return { graceful: true }; },
  };
  const uninstall = installProcessHandlers({ lifecycle, logger: logger(), processRef });
  try {
    const failure = new Error("fatal");
    processRef.emit("unhandledRejection", failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processRef.exitCode, 1);
    assert.deepEqual(events, [["unhandled_rejection", { failed: true }]]);
  } finally {
    uninstall();
  }
});
