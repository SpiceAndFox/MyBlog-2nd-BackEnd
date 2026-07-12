const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMemoryV2Config } = require("../../modules/memory/config/loadConfig");

test("v2 config is inert while feature is disabled", () => assert.deepEqual(loadMemoryV2Config({}), { enabled: false }));
test("v2 config fails explicitly when enabled configuration is incomplete", () => {
  assert.throws(() => loadMemoryV2Config({ CHAT_MEMORY_V2_ENABLED: "true" }), /Missing required env/);
});
