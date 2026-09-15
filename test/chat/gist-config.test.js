const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGistRuntimeConfig } = require("../../config/gistRuntime");
const { createGistWorker } = require("../../modules/chat/application/gistWorker");

test("gist policy defaults and environment overrides are resolved in the configuration layer", () => {
  const config = loadGistRuntimeConfig({});
  assert.deepEqual(config, { pollIntervalMs: 1000, leaseGraceMs: 60000, backfillMaxPerRequest: 10,
    retry: { retryMax: 5, backoffBaseMs: 30000, backoffMaxMs: 120000 } });
  const configured = loadGistRuntimeConfig({ CHAT_GIST_POLL_INTERVAL_MS: "700", CHAT_GIST_LEASE_GRACE_MS: "900",
    CHAT_GIST_BACKFILL_MAX_PER_REQUEST: "3", CHAT_GIST_RETRY_MAX: "0", CHAT_GIST_RETRY_BACKOFF_BASE_MS: "50", CHAT_GIST_RETRY_BACKOFF_MAX_MS: "200" });
  assert.deepEqual(configured, { pollIntervalMs: 700, leaseGraceMs: 900, backfillMaxPerRequest: 3,
    retry: { retryMax: 0, backoffBaseMs: 50, backoffMaxMs: 200 } });
  assert.ok(Object.isFrozen(configured) && Object.isFrozen(configured.retry));
});

test("gist config rejects malformed values instead of silently using a default", () => {
  for (const name of ["CHAT_GIST_POLL_INTERVAL_MS", "CHAT_GIST_LEASE_GRACE_MS", "CHAT_GIST_BACKFILL_MAX_PER_REQUEST", "CHAT_GIST_RETRY_MAX", "CHAT_GIST_RETRY_BACKOFF_BASE_MS", "CHAT_GIST_RETRY_BACKOFF_MAX_MS"]) {
    for (const raw of ["junk", "1.5", "50ms", "-1", "Infinity", "9007199254740992", " "]) {
      assert.throws(() => loadGistRuntimeConfig({ [name]: raw }), new RegExp(name));
    }
    if (name !== "CHAT_GIST_RETRY_MAX") assert.throws(() => loadGistRuntimeConfig({ [name]: "0" }), new RegExp(name));
  }
  assert.throws(() => loadGistRuntimeConfig({ CHAT_GIST_RETRY_BACKOFF_MAX_MS: "1" }), /BACKOFF_MAX_MS/);
});

test("worker requires resolved policy rather than supplying its own defaults", () => {
  const config = { ...loadGistRuntimeConfig({}), workerConcurrency: 1, workerTimeoutMs: 100 };
  for (const key of ["pollIntervalMs", "leaseGraceMs", "workerConcurrency", "workerTimeoutMs", "retry"]) {
    const incomplete = { ...config }; delete incomplete[key];
    assert.throws(() => createGistWorker({ config: incomplete }), /Gist config/);
  }
  for (const key of ["retryMax", "backoffBaseMs", "backoffMaxMs"]) {
    const retry = { ...config.retry }; delete retry[key];
    assert.throws(() => createGistWorker({ config: { ...config, retry } }), /Gist config/);
  }
});
