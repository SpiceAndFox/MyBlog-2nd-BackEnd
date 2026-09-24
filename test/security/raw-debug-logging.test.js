const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createLogger } = require("../../logger");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseConfig(dir, overrides = {}) {
  return {
    nodeEnv: "test",
    level: "info",
    toConsole: false,
    toFile: true,
    dir,
    errorFile: "error.log",
    warnFile: "warn.log",
    infoFile: "info.log",
    debugFile: "debug.log",
    chatFile: "chat.log",
    debugFullFile: "debug-full.log",
    debugGistFile: "debug-gist.log",
    debugFullEnabled: false,
    debugGistEnabled: false,
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test("importing the logger does not create or delete log files", () => {
  const dir = tempDir("prompt-debug-import-");
  const loggerPath = require.resolve("../../logger");
  const cachedLoggerModule = require.cache[loggerPath];
  try {
    const canaryPath = path.join(dir, "debug-full.log");
    fs.writeFileSync(canaryPath, "import-side-effect-canary");

    delete require.cache[loggerPath];
    require(loggerPath);

    assert.equal(fs.readFileSync(canaryPath, "utf8"), "import-side-effect-canary");
    assert.deepEqual(fs.readdirSync(dir), ["debug-full.log"]);
  } finally {
    if (cachedLoggerModule) require.cache[loggerPath] = cachedLoggerModule;
    else delete require.cache[loggerPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("full prompt logging is disabled by default and legacy raw files are cleaned up", () => {
  const dir = tempDir("prompt-debug-disabled-");
  try {
    const fullPath = path.join(dir, "debug-full.log");
    const gistPath = path.join(dir, "debug-gist.log");
    fs.writeFileSync(fullPath, "legacy-full");
    fs.writeFileSync(gistPath, "legacy-gist");

    const logger = createLogger({ config: baseConfig(dir) });

    assert.equal(fs.existsSync(fullPath), false);
    assert.equal(fs.existsSync(gistPath), false);
    logger.debugFull("chat_api_request", { messages: [{ role: "user", content: "blocked" }] });
    assert.equal(fs.existsSync(fullPath), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled full prompt logging keeps existing files and writes structured JSON independent of LOG_LEVEL", async () => {
  const dir = tempDir("prompt-debug-enabled-");
  try {
    const fullPath = path.join(dir, "debug-full.log");
    fs.writeFileSync(fullPath, "previous-entry\n");

    const logger = createLogger({
      config: baseConfig(dir, { debugFullEnabled: true, level: "info" }),
    });
    assert.equal(fs.readFileSync(fullPath, "utf8"), "previous-entry\n");

    const payload = {
      messages: [{ role: "user", content: "full prompt" }],
      settings: { systemPromptPresetId: "default" },
    };
    logger.debugFull("chat_api_request", payload);

    const written = await waitFor(() => {
      const text = fs.readFileSync(fullPath, "utf8");
      return text.includes("chat_api_request") && text.includes("full prompt");
    });
    assert.equal(written, true, "expected debug-full.log to contain the full prompt entry");

    const lines = fs.readFileSync(fullPath, "utf8").trimEnd().split("\n");
    assert.equal(lines[0], "previous-entry");
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.level, "debug_full");
    assert.equal(entry.message, "chat_api_request");
    assert.deepEqual(entry.meta, payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production cannot enable full prompt logging", () => {
  const dir = tempDir("prompt-debug-production-");
  try {
    assert.throws(
      () => createLogger({
        config: baseConfig(dir, {
          nodeEnv: "production",
          debugFullEnabled: true,
          toFile: false,
        }),
      }),
      /Raw chat debug logging cannot be enabled in production/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});