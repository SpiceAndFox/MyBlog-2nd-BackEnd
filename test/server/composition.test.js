const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");
const express = require("express");
const { createApplicationComposition } = require("../../app/composition/createApplication");
const { createBackgroundServices } = require("../../app/composition/backgroundServices");
const { createArticleTempImageCleanup } = require("../../modules/blog");

function fixtureEnvironment() {
  const environment = dotenv.parse(fs.readFileSync(path.join(__dirname, "../../.env.example")));
  return {
    ...environment,
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
    JWT_SECRET: "composition-test-secret",
    DEEPSEEK_API_KEY: "test-key",
    XAI_API_KEY: "test-key",
    GEMINI_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test-key",
    OPENCODE_GO_API_KEY: "test-key",
    OPENCODE_ZEN_API_KEY: "test-key",
    CHAT_RAG_EMBEDDING_API_KEY: "test-key",
    CHAT_RAG_RERANKER_API_KEY: "test-key",
    CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    LOG_TO_CONSOLE: "false",
    LOG_TO_FILE: "false",
  };
}

function logger() {
  return {
    log() {},
    error() {},
    warn() {},
    info() {},
    chat() {},
    debug() {},
  };
}

test("composition creates process-level adapters explicitly without starting background work", () => {
  const originalSetInterval = global.setInterval;
  let intervalCount = 0;
  global.setInterval = (...args) => {
    intervalCount += 1;
    return originalSetInterval(...args);
  };
  try {
    const database = { query() {}, getClient() {}, async end() {} };
    const memoryRuntime = { enabled: false, async shutdown() {} };
    const composition = createApplicationComposition({
      environment: fixtureEnvironment(),
      loadDotenv: false,
      adapters: {
        app: express(),
        database,
        logger: logger(),
        memoryRuntime,
      },
    });

    assert.equal(composition.database, database);
    assert.equal(composition.memoryRuntime, memoryRuntime);
    assert.equal(composition.config.authConfig.jwtSecret, "composition-test-secret");
    assert.equal(Object.isFrozen(composition.config), true);
    assert.equal(Object.isFrozen(composition.config.chatConfig), true);
    assert.equal(intervalCount, 0);
  } finally {
    global.setInterval = originalSetInterval;
  }
});

test("composition wires the Chat public module and injected router without starting requests", () => {
  const database = { query() {}, getClient() {}, async end() {} };
  const memoryRuntime = {
    enabled: false,
    async assembleContext() { throw new Error("not called during composition"); },
    async processScope() {},
    async rebuildScope() {},
    async mutateSourceAndRebuild() {},
    async privacyHardDelete() {},
    async getPrivacyOperation() {},
    async markRecoveryNotificationsDelivered() {},
    async shutdown() {},
  };
  const composition = createApplicationComposition({
    environment: fixtureEnvironment(),
    loadDotenv: false,
    adapters: { database, logger: logger(), memoryRuntime },
  });

  assert.equal(typeof composition.chat.chatModule.sendMessage, "function");
  assert.equal(typeof composition.chat.chatModule.editMessage, "function");
  assert.equal(typeof composition.chat.chatModule.presets.create, "function");
  assert.equal(typeof composition.chat.chatModule.sessions.create, "function");
  assert.equal(typeof composition.chat.chatModule.trashCleanup.start, "function");
  assert.equal(typeof composition.chat.router, "function");
  assert.equal(typeof composition.app, "function");
});

test("background services start in declaration order and drain in reverse order", async () => {
  const events = [];
  const services = createBackgroundServices([
    {
      name: "first",
      start() { events.push("first:start"); return async () => { events.push("first:stop"); }; },
    },
    {
      name: "second",
      start() { events.push("second:start"); return async () => { events.push("second:stop"); }; },
    },
  ]);
  const stop = await services.start();
  await stop();
  assert.deepEqual(events, ["first:start", "second:start", "second:stop", "first:stop"]);
});

test("article temp cleanup removes only expired files through an explicitly created service", async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "article-temp-cleanup-"));
  const expired = path.join(tempDirectory, "expired.png");
  const current = path.join(tempDirectory, "current.png");
  try {
    fs.writeFileSync(expired, "expired");
    fs.writeFileSync(current, "current");
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(expired, oldTime, oldTime);
    const cleanup = createArticleTempImageCleanup({
      logger: logger(),
      ttlMs: 60_000,
      intervalMs: 60_000,
      tempDirectory,
    });
    assert.deepEqual(await cleanup.cleanup(), { removed: 1 });
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(current), true);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
