const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatController } = require("../../controllers/chatController");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function createController({ memory, rag }) {
  return createChatController({
    chatModule: {
      async sendMessage() {},
      async editMessage() {},
      presets: {},
      sessions: {},
    },
    memory: {
      async markRecoveryNotificationsDelivered() {},
      ...memory,
    },
    rag,
    config: { rag: { enabled: true, debugIncludeContent: false } },
    logger: { error() {}, warn() {} },
    withRequestContext: (_req, value) => value,
  });
}

test("chat health reports unknown providers without spending an API call", async () => {
  let providerCalls = 0;
  const controller = createController({
    memory: {
      async getHealthSnapshot() {
        return {
          provider: { status: "unknown" },
          scope: { status: "healthy", usable: true, alerts: [] },
        };
      },
    },
    rag: {
      getHealthSnapshot() {
        providerCalls += 1;
        return { embeddingProvider: { status: "unknown" } };
      },
    },
  });
  const response = createResponse();

  await controller.getHealth({ user: { id: 7 }, query: { presetId: "companion" } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "unknown");
  assert.deepEqual(response.body.warnings, []);
  assert.equal(providerCalls, 1, "health reads only in-memory state; this is not a model call");
});

test("chat health exposes provider and stale-memory warnings for the page", async () => {
  const controller = createController({
    memory: {
      async getHealthSnapshot() {
        return {
          provider: {
            status: "degraded",
            reason: "http_401",
            lastFailureAt: "2026-07-25T00:00:00.000Z",
            retryMode: "manual",
          },
          scope: {
            status: "rebuilding",
            usable: true,
            alerts: [{
              subjectKind: "target",
              subjectKey: "scene",
              status: "rebuilding",
              message: "scene 记忆正在从已保存进度继续重建",
            }],
          },
        };
      },
    },
    rag: {
      getHealthSnapshot() {
        return {
          embeddingProvider: {
            status: "degraded",
            reason: "network",
            nextRetryAt: "2026-07-25T00:01:00.000Z",
            retryMode: "automatic",
          },
        };
      },
    },
  });
  const response = createResponse();

  await controller.getHealth({ user: { id: 7 }, query: { presetId: "companion" } }, response);

  assert.equal(response.body.status, "degraded");
  assert.deepEqual(response.body.warnings.map((warning) => warning.component), [
    "memory",
    "embedding",
    "memory",
  ]);
  assert.match(response.body.warnings[0].message, /最近一次/);
  assert.match(response.body.warnings[1].message, /后续请求仍会正常尝试/);
});

test("manual embedding retry directly resumes projection work and then reads health", async () => {
  const calls = [];
  const controller = createController({
    memory: {
      async drainProjections(userId, presetId) {
        calls.push(["drain", userId, presetId]);
        return { rag: { status: "healthy" } };
      },
    },
    rag: {
      getHealthSnapshot() {
        calls.push(["health"]);
        return { embeddingProvider: { status: "healthy" } };
      },
    },
  });
  const response = createResponse();

  await controller.retryHealth({
    user: { id: 7 },
    body: { component: "embedding", presetId: "companion" },
  }, response);

  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls, [["drain", 7, "companion"], ["health"]]);
  assert.equal(response.body.result.projection.rag.status, "healthy");
});
