const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderAdmission, admissionControlledAdapter } = require("../../../modules/memory/application/providerAdmission");

test("global Provider admission bounds active calls and its admitted queue across 50 scopes", async () => {
  const admission = createProviderAdmission({ concurrency: 3, queueMax: 5 });
  let active = 0;
  let maxActive = 0;
  let maxQueued = 0;
  const started = [];
  const timer = setInterval(() => { maxQueued = Math.max(maxQueued, admission.snapshot().queued); }, 1);
  const jobs = Array.from({ length: 50 }, async (_, index) => {
    while (true) {
      const scheduled = admission.tryRun(async () => {
        started.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        active -= 1;
        if (index === 17) throw new Error("expected failure");
        return index;
      });
      if (scheduled) return scheduled;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  const settled = await Promise.allSettled(jobs);
  clearInterval(timer);
  assert.equal(maxActive, 3);
  assert.equal(maxQueued <= 5, true);
  assert.deepEqual([...started].sort((a, b) => a - b), Array.from({ length: 50 }, (_, index) => index));
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, concurrency: 3, queueMax: 5 });
});

test("Provider admission releases a permit after synchronous failure", async () => {
  const admission = createProviderAdmission({ concurrency: 1, queueMax: 1 });
  await assert.rejects(admission.run(() => { throw new Error("boom"); }), /boom/);
  assert.equal(await admission.run(() => "recovered"), "recovered");
});

test("Provider admission preserves schema repair options", async () => {
  const admission = createProviderAdmission({ concurrency: 1, queueMax: 1 });
  let received;
  const adapter = admissionControlledAdapter({
    async propose(_envelope, options) { received = options; return { status: "ok" }; },
  }, admission);
  const repairFeedback = { attempt: 1, errors: [{ path: "$.dueAt", message: "invalid" }] };
  assert.deepEqual(await adapter.propose({ id: 1 }, { repairFeedback }), { status: "ok" });
  assert.deepEqual(received, { repairFeedback });
});

test("a saturated admission queue defers excess durable work without calling the Provider", async () => {
  const admission = createProviderAdmission({ concurrency: 1, queueMax: 1 });
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = admissionControlledAdapter({
    async propose(envelope) {
      calls += 1;
      if (envelope.id === 1) await gate;
      return { status: "ok", output: envelope.id };
    },
  }, admission);
  const first = adapter.propose({ id: 1 });
  const second = adapter.propose({ id: 2 });
  assert.deepEqual(await adapter.propose({ id: 3 }), { status: "deferred", reason: "provider_queue_full" });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "ok", output: 1 },
    { status: "ok", output: 2 },
  ]);
});

test("global admission composes with per-scope lanes without reordering any scope after failures", async () => {
  const admission = createProviderAdmission({ concurrency: 4, queueMax: 200 });
  const lanes = new Map();
  const orderByScope = new Map();
  let active = 0;
  let maxActive = 0;

  function enqueueScope(scope, work) {
    const previous = lanes.get(scope) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    lanes.set(scope, current);
    return current;
  }

  const work = [];
  for (let scopeIndex = 0; scopeIndex < 20; scopeIndex += 1) {
    const scope = `scope-${scopeIndex}`;
    orderByScope.set(scope, []);
    for (let sequence = 0; sequence < 5; sequence += 1) {
      work.push(enqueueScope(scope, () => admission.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        orderByScope.get(scope).push(sequence);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (scopeIndex === 7 && sequence === 2) throw new Error("injected Provider failure");
      })));
    }
  }

  const settled = await Promise.allSettled(work);
  assert.equal(maxActive, 4);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  for (const observed of orderByScope.values()) assert.deepEqual(observed, [0, 1, 2, 3, 4]);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, concurrency: 4, queueMax: 200 });
});
