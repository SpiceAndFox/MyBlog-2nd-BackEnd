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

test("logger startup removes legacy raw prompt files and production cannot recreate them", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v2-raw-logs-"));
  const fullPath = path.join(tempDir, "debug-full.log");
  const gistPath = path.join(tempDir, "debug-gist.log");
  fs.writeFileSync(fullPath, "unique-chat-canary");
  fs.writeFileSync(gistPath, "unique-gist-canary");
  try {
    const cleanup = spawnSync(process.execPath, ["-e", "require('./logger')"], {
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

    const rejected = spawnSync(process.execPath, ["-e", "require('./logger')"], {
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
