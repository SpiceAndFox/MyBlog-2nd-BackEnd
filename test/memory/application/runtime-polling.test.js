const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime } = require("../../../modules/memory/application/runtime");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");

test("durable task polling continuously scans queued and due retry tasks", async () => {
  let scans = 0;
  const state = createInitialMemoryState();
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const repositories = {
    state: { async getState() { return state; }, async initializeRevisionZero() { return state; } },
    source: { async countAfter() { return 0; } },
    runtime: { async getTargetStatuses() { return []; }, async listRecoverableTasks() { scans += 1; return []; } },
    audit: {}, sidecars: {}, async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: { enabled: true, targets, tasks: { pollIntervalMs: 250 }, projections: { pollIntervalMs: 1000 }, providerRecovery: { haltAfterConsecutiveErrors: 3, retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1, backoffMaxMs: 2 }, compaction: { retryMax: 1 } },
    repositories,
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const stop = runtime.startTaskPolling();
  await new Promise((resolve) => setTimeout(resolve, 320));
  stop();
  assert.ok(scans >= 1);
});
