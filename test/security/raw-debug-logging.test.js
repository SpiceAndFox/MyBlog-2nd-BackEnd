const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

test("raw prompt logging API is absent by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v2-logger-api-"));
  try {
    const result = spawnSync(process.execPath, ["-e", "const { logger } = require('./logger'); process.stdout.write(JSON.stringify({ debugFull: 'debugFull' in logger, debugGist: 'debugGist' in logger }));"], {
      cwd: path.join(__dirname, "../.."),
      env: { ...process.env, NODE_ENV: "test", LOG_DIR: tempDir, LOG_TO_CONSOLE: "false", LOG_TO_FILE: "false" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { debugFull: false, debugGist: false });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("importing the logger does not create or delete log files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v2-logger-import-"));
  const canaryPath = path.join(tempDir, "debug-full.log");
  fs.writeFileSync(canaryPath, "import-side-effect-canary");
  try {
    const result = spawnSync(process.execPath, ["-e", "require('./logger')"], {
      cwd: path.join(__dirname, "../.."),
      env: { ...process.env, LOG_DIR: tempDir, LOG_TO_FILE: "true" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(canaryPath, "utf8"), "import-side-effect-canary");
    assert.deepEqual(fs.readdirSync(tempDir), ["debug-full.log"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("logger startup removes legacy raw prompt files and production cannot recreate them", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v2-raw-logs-"));
  const fullPath = path.join(tempDir, "debug-full.log");
  const gistPath = path.join(tempDir, "debug-gist.log");
  fs.writeFileSync(fullPath, "unique-chat-canary");
  fs.writeFileSync(gistPath, "unique-gist-canary");
  try {
    const createCommand = "const {createLogger}=require('./logger');createLogger({config:{nodeEnv:process.env.NODE_ENV,toConsole:false,toFile:false,dir:process.env.LOG_DIR,debugFullFile:process.env.LOG_DEBUG_FULL_FILE,debugGistFile:process.env.LOG_DEBUG_GIST_FILE,debugFullEnabled:process.env.LOG_DEBUG_FULL_ENABLED==='true',debugGistEnabled:process.env.LOG_DEBUG_GIST_ENABLED==='true'}})";
    const cleanup = spawnSync(process.execPath, ["-e", createCommand], {
      cwd: path.join(__dirname, "../.."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_DIR: tempDir,
        LOG_TO_CONSOLE: "false",
        LOG_TO_FILE: "false",
        LOG_DEBUG_FULL_FILE: "debug-full.log",
        LOG_DEBUG_GIST_FILE: "debug-gist.log",
        LOG_DEBUG_FULL_ENABLED: "false",
        LOG_DEBUG_GIST_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(fs.existsSync(fullPath), false);
    assert.equal(fs.existsSync(gistPath), false);

    const rejected = spawnSync(process.execPath, ["-e", createCommand], {
      cwd: path.join(__dirname, "../.."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_DIR: tempDir,
        LOG_TO_CONSOLE: "false",
        LOG_TO_FILE: "false",
        LOG_DEBUG_FULL_ENABLED: "true",
        LOG_DEBUG_GIST_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Raw chat debug logging cannot be enabled in production/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
