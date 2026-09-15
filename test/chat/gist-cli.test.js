const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs } = require("../../scripts/retry-chat-gists");
const { chatHttpFailure } = require("../../modules/chat/infrastructure/llm/adapters/httpFailure");

test("manual gist retry requires exactly one explicit user/preset scope", () => {
  assert.deepEqual(parseArgs(["--userId", "1", "--presetId", "Lina-Weil", "--messageId", "8505"]), { userId: 1, presetId: "Lina-Weil", messageId: 8505 });
  assert.deepEqual(parseArgs(["--userId", "1", "--presetId", "p"]), { userId: 1, presetId: "p", messageId: null });
  for (const args of [[], ["--userId", "1"], ["--userId", "0", "--presetId", "p"], ["--userId", "1", "--presetId", "p", "--messageId", "-1"], ["--userId", "1", "--presetId", "p", "--all", "true"], ["--userId", "1", "--userId", "2", "--presetId", "p"]]) assert.throws(() => parseArgs(args));
});

test("LLM HTTP failures preserve classification and server Retry-After", () => {
  const started = Date.now();
  const error = chatHttpFailure("busy", { status: 429, headers: { get: () => "60" } });
  assert.equal(error.status, 429); assert.equal(error.message, "busy");
  assert.ok(Date.parse(error.retryAfterAt) >= started + 60000);
  assert.equal(chatHttpFailure("unauthorized", { status: 401, headers: { get: () => null } }).retryAfterAt, null);
});
