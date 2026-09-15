const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGistRuntimeConfig } = require("../../config/gistRuntime");
const { createGistWorker } = require("../../modules/chat/application/gistWorker");
const { gistTestEnvironment } = require("./support/gist-env");

test("gist policy is resolved exclusively from explicit environment values", () => {
  const configured = loadGistRuntimeConfig(gistTestEnvironment());
  assert.deepEqual(configured, { pollIntervalMs: 700, leaseGraceMs: 900, backfillMaxPerRequest: 3,
    retry: { retryMax: 0, backoffBaseMs: 50, backoffMaxMs: 200 } });
  assert.ok(Object.isFrozen(configured) && Object.isFrozen(configured.retry));
});

test("every gist policy field is required, including when retries are disabled", () => {
  assert.throws(() => loadGistRuntimeConfig({}), /Missing required env/);
  for (const name of Object.keys(gistTestEnvironment())) {
    const missing = gistTestEnvironment(); delete missing[name];
    assert.throws(() => loadGistRuntimeConfig(missing), new RegExp(`Missing required env: ${name}`));
    for (const raw of [undefined, null, "", " ", "\t", 100]) {
      assert.throws(() => loadGistRuntimeConfig({ ...gistTestEnvironment(), [name]: raw }), new RegExp(`Missing required env: ${name}`));
    }
  }
});

test("gist config rejects malformed values instead of silently using a default", () => {
  for (const name of ["CHAT_GIST_POLL_INTERVAL_MS", "CHAT_GIST_LEASE_GRACE_MS", "CHAT_GIST_BACKFILL_MAX_PER_REQUEST", "CHAT_GIST_RETRY_MAX", "CHAT_GIST_RETRY_BACKOFF_BASE_MS", "CHAT_GIST_RETRY_BACKOFF_MAX_MS"]) {
    for (const raw of ["junk", "1.5", "50ms", "-1", "Infinity", "9007199254740992", " "]) {
      assert.throws(() => loadGistRuntimeConfig({ ...gistTestEnvironment(), [name]: raw }), new RegExp(name));
    }
    if (name !== "CHAT_GIST_RETRY_MAX") assert.throws(() => loadGistRuntimeConfig({ ...gistTestEnvironment(), [name]: "0" }), new RegExp(name));
  }
  assert.throws(() => loadGistRuntimeConfig({ ...gistTestEnvironment(), CHAT_GIST_RETRY_BACKOFF_MAX_MS: "1" }), /BACKOFF_MAX_MS/);
});

test("worker requires resolved policy rather than supplying its own defaults", () => {
  const config = { ...loadGistRuntimeConfig(gistTestEnvironment()), workerConcurrency: 1, workerTimeoutMs: 100 };
  for (const key of ["pollIntervalMs", "leaseGraceMs", "workerConcurrency", "workerTimeoutMs", "retry"]) {
    const incomplete = { ...config }; delete incomplete[key];
    assert.throws(() => createGistWorker({ config: incomplete }), /Gist config/);
  }
  for (const key of ["retryMax", "backoffBaseMs", "backoffMaxMs"]) {
    const retry = { ...config.retry }; delete retry[key];
    assert.throws(() => createGistWorker({ config: { ...config, retry } }), /Gist config/);
  }
});
