const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatController } = require("../../controllers/chatController");

function response() {
  return {
    statusCode: 200, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}
function controller(memory) {
  return createChatController({
    chatModule: { async sendMessage() {}, async editMessage() {}, presets: {}, sessions: {} },
    memory: { async markRecoveryNotificationsDelivered() {}, ...memory },
    logger: { error() {}, warn() {} },
    withRequestContext: (_req, value) => value,
  });
}

test("chat health reports Memory status without a retrieval provider or configuration", async () => {
  let reads = 0;
  const app = controller({ async getHealthSnapshot() {
    reads++;
    return { provider: { status: "healthy" }, scope: { status: "healthy", usable: true, alerts: [] } };
  } });
  const res = response();
  await app.getHealth({ user: { id: 7 }, query: { presetId: "companion" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "healthy");
  assert.equal(reads, 1);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(Object.hasOwn(res.body, "rag"), false);
});

test("an unobserved Memory provider remains unknown", async () => {
  const res = response();
  await controller({ async getHealthSnapshot() { return { provider: { status: "unknown" } }; } })
    .getHealth({ user: { id: 7 }, query: { presetId: "companion" } }, res);
  assert.equal(res.body.status, "unknown");
});

test("Memory provider and rebuilding warnings are retained", async () => {
  const app = controller({ async getHealthSnapshot() { return {
    provider: { status: "degraded", reason: "http_401" },
    scope: { alerts: [{ subjectKind: "target", subjectKey: "scene", status: "rebuilding", message: "scene 记忆正在重建" }] },
  }; } });
  const res = response();
  await app.getHealth({ user: { id: 7 }, query: { presetId: "companion" } }, res);
  assert.equal(res.body.status, "degraded");
  assert.deepEqual(res.body.warnings.map(warning => warning.component), ["memory", "memory"]);
  assert.match(res.body.warnings[0].message, /最近一次/);
  assert.match(res.body.warnings[1].message, /记忆正在重建/);
});

test("manual retry accepts Memory and rejects the retired embedding component", async () => {
  const calls = [];
  const app = controller({ async retryProviderNow(input) { calls.push(input); return { attempted: true }; } });
  const retired = response();
  await app.retryHealth({ user: { id: 7 }, body: { component: "embedding", presetId: "companion" } }, retired);
  assert.equal(retired.statusCode, 400);
  assert.deepEqual(calls, []);
  const res = response();
  await app.retryHealth({ user: { id: 7 }, body: { component: "memory", presetId: "companion" } }, res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(calls, [{ userId: 7, presetId: "companion" }]);
  assert.equal(res.body.result.attempted, true);
});
