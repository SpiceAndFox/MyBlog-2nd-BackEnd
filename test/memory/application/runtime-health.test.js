const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createMemoryRuntimeHealth } = require("../../../modules/memory/application/runtimeHealth");

const { createProviderHealth } = require("../../../shared/observability/providerHealth");

test("runtime health exposes resumable progress without leaking internal target errors", async () => {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 3;
  state.meta.targetCursors.scene = 12;
  const health = createMemoryRuntimeHealth({
    config: { targets: { scene: {} } },
    repositories: {
      state: { async getState() { return structuredClone(state); } },
      runtime: {
        async getTargetStatuses() {
          return [{
            target_key: "scene",
            status: "halted",
            rebuild_boundary_message_id: 20,
            last_error_reason: "secret-provider-detail",
          }];
        },
      },
      sidecars: {
        async listProjectionCheckpoints() {
          return [{
            projection_key: "rag",
            status: "rebuilding",
            processed_generation: 3,
            processed_boundary_message_id: 10,
            last_error_reason: "secret-embedding-detail",
          }];
        },
      },
    },
    providerHealth: createProviderHealth({ name: "memory" }),
    async reconcileRebuilds() { return {}; },
    recovery: { async resumeTarget() {} },
  });

  const snapshot = await health.getHealthSnapshot({ userId: 7, presetId: "companion" });

  assert.equal(snapshot.scope.status, "degraded");
  assert.equal(snapshot.scope.usable, true);
  assert.deepEqual(snapshot.scope.targets, [{
    targetKey: "scene",
    status: "needs_attention",
    processedMessageId: 12,
    rebuildBoundaryMessageId: 20,
  }]);
  assert.deepEqual(snapshot.scope.projection, {
    status: "rebuilding",
    processedGeneration: 3,
    processedBoundaryMessageId: 10,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-provider-detail|secret-embedding-detail/);
});

test("runtime health fails closed when authority memory cannot be validated", async () => {
  const health = createMemoryRuntimeHealth({
    config: { targets: { scene: {} } },
    repositories: {
      state: { async getState() { throw new Error("invalid authority"); } },
      runtime: {},
      sidecars: {},
    },
    providerHealth: createProviderHealth({ name: "memory" }),
    async reconcileRebuilds() { return {}; },
    recovery: { async resumeTarget() {} },
  });

  const snapshot = await health.getHealthSnapshot({ userId: 7, presetId: "companion" });

  assert.equal(snapshot.scope.status, "unavailable");
  assert.equal(snapshot.scope.usable, false);
  assert.match(snapshot.scope.alerts[0].message, /不会使用该记忆/);
  assert.doesNotMatch(JSON.stringify(snapshot), /invalid authority/);
});

test("manual runtime retry is scoped and directly runs halted target recovery", async () => {
  const calls = [];
  const health = createMemoryRuntimeHealth({
    config: { targets: { todos: {} } },
    repositories: {
      state: {},
      runtime: {
        async getTargetStatuses(userId, presetId) {
          calls.push(["statuses", userId, presetId]);
          return [{ target_key: "todos", status: "halted" }];
        },
      },
      sidecars: {},
    },
    providerHealth: createProviderHealth({ name: "memory" }),
    async reconcileRebuilds(options) {
      calls.push(["rebuilds", options]);
      return { "7:companion": { status: "skipped", reason: "not_rebuilding" } };
    },
    recovery: {
      async resumeTarget(userId, presetId, targetKey, options) {
        calls.push(["resume", userId, presetId, targetKey, options]);
        return { status: "committed" };
      },
    },
  });

  const result = await health.retryProviderNow({ userId: 7, presetId: "companion" });

  assert.equal(result.attempted, true);
  assert.deepEqual(result.resumed, [{ status: "committed" }]);
  assert.deepEqual(calls.at(-1), ["resume", 7, "companion", "todos", { run: true }]);
});
