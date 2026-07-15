const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { logger } = require("../../logger");

test("raw prompt logging is absent by default and rejected in production", () => {
  const loggerPath = path.join(__dirname, "../../logger.js");
  assert.equal("debugFull" in logger, false);
  assert.equal("debugGist" in logger, false);
  const source = fs.readFileSync(loggerPath, "utf8");
  assert.match(source, /NODE_ENV[\s\S]*production[\s\S]*LOG_DEBUG_FULL_ENABLED[\s\S]*throw new Error\("Raw chat debug logging cannot be enabled in production"\)/);
});
