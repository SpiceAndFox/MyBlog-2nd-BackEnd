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
  assert.equal(Object.hasOwn(snapshot.scope, "projection"), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-provider-detail/);
});

test("runtime health fails closed when authority memory cannot be validated", async () => {
  const health = createMemoryRuntimeHealth({
    config: { targets: { scene: {} } },
    repositories: {
      state: { async getState() { throw new Error("invalid authority"); } },
      runtime: {},
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

test("runtime distinguishes background updates from a paused target regardless of target order", async () => {
  for (const paused of [null, "scene", "todos"]) {
    const health = createMemoryRuntimeHealth({
      config: { targets: { scene: {}, todos: {} } },
      repositories: {
        state: { async getState() { return createInitialMemoryState(); } },
        runtime: { async getTargetStatuses() {
          return ["scene", "todos"].map(target_key => ({ target_key,
            status: target_key === paused ? "halted" : "rebuilding", rebuild_boundary_message_id: 20 }));
        } },
      },
      providerHealth: createProviderHealth({ name: "memory" }),
      async reconcileRebuilds() { return {}; },
      recovery: { async resumeTarget() {} },
    });
    const snapshot = await health.getHealthSnapshot({ userId: 7, presetId: "companion" });
    assert.equal(snapshot.scope.usable, true);
    assert.equal(snapshot.scope.status, paused ? "degraded" : "rebuilding");
    if (!paused) {
      assert.deepEqual(snapshot.scope.alerts.map(alert => alert.message), ["当前状态记忆正在后台更新", "待办记忆正在后台更新"]);
    } else {
      assert.equal(snapshot.scope.targets.find(target => target.targetKey === paused).status, "needs_attention");
    }
  }
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
