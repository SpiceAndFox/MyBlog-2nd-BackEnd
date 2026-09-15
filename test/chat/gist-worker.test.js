const test = require("node:test");
const assert = require("node:assert/strict");
const { createGistWorker } = require("../../modules/chat/application/gistWorker");
const { gistRetryDecision } = require("../../modules/chat/application/gistRetryPolicy");
const { createGistFixture } = require("./support/gist-fixture");

const config = { enabled: true, workerConcurrency: 1, workerTimeoutMs: 100,
  pollIntervalMs: 1000, leaseGraceMs: 200,
  retry: { retryMax: 2, backoffBaseMs: 30, backoffMaxMs: 60 } };
const logger = { error() {} };
const scope = messageId => ({ userId: 7, presetId: "companion", messageId });
function worker(fixture, generate, options = {}) {
  return createGistWorker({ config, repository: fixture.repository, generate, logger, now: fixture.now, ...options });
}

test("durable retries survive a new worker, honor backoff and stop at the budget", async () => {
  const f = createGistFixture(); f.addSource(12);
  let calls = 0;
  const fail = async () => { calls++; throw new Error("LLM request timeout"); };
  const first = worker(f, fail);
  await first.requestGeneration(scope(12));
  assert.equal(f.tasks.get(12).status, "retry_wait");
  const restarted = worker(f, fail);
  await restarted.poll(); assert.equal(calls, 1);
  f.advance(30); await restarted.poll(); assert.equal(calls, 2);
  f.advance(60); await restarted.poll(); assert.equal(calls, 3);
  assert.equal(f.tasks.get(12).status, "failed");
  f.advance(1000); await restarted.requestGeneration(scope(12)); assert.equal(calls, 3);
  await restarted.requestGeneration({ ...scope(12), force: true }); assert.equal(calls, 4);
  assert.equal(f.tasks.get(12).attempt, 1);
});

test("backoff releases the worker slot for another message, then recovers", async () => {
  const f = createGistFixture(); f.addSource(12); f.addSource(14);
  let first = true;
  const service = worker(f, async source => {
    if (source.messageId === 12 && first) { first = false; throw Object.assign(new Error("busy"), { status: 429 }); }
    return { gistText: "ok" };
  });
  await service.requestGeneration(scope(12));
  await service.requestGeneration(scope(14));
  assert.equal(f.tasks.get(14).status, "succeeded");
  f.advance(30); await service.poll(); assert.equal(f.tasks.get(12).status, "succeeded");
});

test("source edit or deletion during generation rejects stale results", async () => {
  for (const edit of [false, true]) {
    const f = createGistFixture(); f.addSource(12);
    const service = worker(f, async () => {
      if (edit) f.addSource(12, "changed source"); else f.sources.delete(12);
      return { gistText: "old" };
    });
    await service.requestGeneration(scope(12));
    assert.equal(f.tasks.get(12).status, "cancelled"); assert.equal(f.stored.size, 0);
  }
});

test("expired leases consume the retry budget and cannot be reclaimed indefinitely", async () => {
  const f = createGistFixture(); f.addSource(12); await f.repository.enqueueGistTask(scope(12));
  for (let n = 0; n < 3; n++) { await f.repository.claimGistTask({ leaseMs: 1 }); f.advance(2); }
  let calls = 0;
  await worker(f, async () => { calls++; return {}; }).poll();
  assert.equal(calls, 0); assert.equal(f.tasks.get(12).status, "failed");
});

test("shutdown aborts in-flight generation and leaves recoverable work", async () => {
  const f = createGistFixture(); f.addSource(12);
  let ready; const started = new Promise(resolve => { ready = resolve; });
  const service = worker(f, async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); ready();
  }));
  const request = service.requestGeneration(scope(12)); await started; await service.stop(); await request;
  assert.equal(f.tasks.get(12).status, "retry_wait");
  await worker(f, async () => ({ gistText: "recovered" })).poll();
  assert.equal(f.tasks.get(12).status, "succeeded");
});

test("permanent HTTP errors stop, transient failures and Retry-After retry", () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(gistRetryDecision({ status }, 1, config.retry, 0).status, "failed");
  for (const status of [408, 429, 500, 503]) assert.equal(gistRetryDecision({ status }, 1, config.retry, 0).status, "retry_wait");
  assert.equal(gistRetryDecision({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }, 1, config.retry, 0).status, "retry_wait");
  assert.equal(gistRetryDecision({ status: 400, message: "invalid timeout parameter" }, 1, config.retry, 0).status, "failed");
  assert.equal(gistRetryDecision({ status: 429, retryAfterAt: new Date(200).toISOString() }, 1, config.retry, 0).nextRetryAt, new Date(200).toISOString());
});

test("starting the worker recovers queued work without another chat request", async () => {
  const f = createGistFixture(); f.addSource(12); await f.repository.enqueueGistTask(scope(12));
  let ready; const generated = new Promise(resolve => { ready = resolve; });
  const service = worker(f, async () => { ready(); return { gistText: "startup" }; });
  service.start(); await generated; await service.stop();
  assert.equal(f.tasks.get(12).status, "succeeded");
});

test("overlapping poll and request triggers respect local concurrency", async () => {
  const f = createGistFixture();
  for (const id of [12, 14, 16]) { f.addSource(id); await f.repository.enqueueGistTask(scope(id)); }
  let active = 0; let peak = 0;
  const release = [];
  let ready; const bothStarted = new Promise(resolve => { ready = resolve; });
  const service = worker(f, async () => {
    active++; peak = Math.max(peak, active); if (active === 2) ready();
    await new Promise(resolve => release.push(resolve)); active--;
    return { gistText: "ok" };
  }, { config: { ...config, workerConcurrency: 2 } });
  const polling = service.poll(); await bothStarted;
  await Promise.all([service.poll(), service.requestGeneration(scope(16))]);
  assert.equal(peak, 2); assert.equal(f.tasks.get(16).status, "queued");
  release.forEach(resolve => resolve()); await polling; await service.stop();
});
