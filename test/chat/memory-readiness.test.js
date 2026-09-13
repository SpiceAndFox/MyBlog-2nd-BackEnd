const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatScopeCoordinator } = require("../../modules/chat/application/scopeCoordinator");
const { createMemoryReadinessRunner, COVERAGE_PENDING } = require("../../modules/chat/application/memoryReadiness");

const pending = () => Object.assign(new Error("coverage pending"), { code: COVERAGE_PENDING });

test("coverage waits release the mutation lane and preserve send ordering across sessions", { timeout: 2000 }, async () => {
  const scopeCoordinator = createChatScopeCoordinator();
  const events = [];
  let ready = false;
  const run = createMemoryReadinessRunner({ scopeCoordinator, timeoutMs: 1000,
    wait: async () => new Promise(setImmediate),
    memory: { requestContextCatchup: () => scopeCoordinator.enqueueByKey("1:p", () => {
      events.push("recovery"); ready = true;
    }) },
  });
  const first = run({ key: "1:p", userId: 1, presetId: "p", execute() {
    if (!ready) { events.push("wait"); throw pending(); }
    events.push("first-reply"); return "first";
  } });
  const second = run({ key: "1:p", userId: 1, presetId: "p", execute() {
    events.push("second-reply"); return "second";
  } });
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["wait", "recovery", "first-reply", "second-reply"]);
  await scopeCoordinator.waitForIdle();
});

test("coverage readiness does not request any Memory work when the context is already complete", async () => {
  const run = createMemoryReadinessRunner({ scopeCoordinator: createChatScopeCoordinator(), timeoutMs: 1000,
    memory: { requestContextCatchup() { assert.fail("unneeded rebuild"); } },
  });
  assert.equal(await run({ key: "1:p", execute: () => "ready" }), "ready");
});

test("a source mutation cancels waiting and queued sends without blocking its own transaction", { timeout: 2000 }, async () => {
  const scopeCoordinator = createChatScopeCoordinator();
  const started = Promise.withResolvers();
  const run = createMemoryReadinessRunner({ scopeCoordinator, timeoutMs: 1000,
    memory: { requestContextCatchup() { started.resolve(); } },
  });
  let attempts = 0;
  const first = run({ key: "1:p", execute() { attempts++; throw pending(); } });
  const second = run({ key: "1:p", execute() { assert.fail("queued send must be cancelled"); } });
  const rejected = [assert.rejects(first, { code: "CHAT_SCOPE_MUTATED" }), assert.rejects(second, { code: "CHAT_SCOPE_MUTATED" })];
  await started.promise;
  scopeCoordinator.cancelByKey("1:p", Object.assign(new Error("edited"), { code: "CHAT_SCOPE_MUTATED" }));
  assert.equal(await scopeCoordinator.enqueueByKey("1:p", () => "committed"), "committed");
  await Promise.all(rejected);
  assert.equal(attempts, 1);
  await scopeCoordinator.waitForIdle();
});

test("coverage timeout returns the pending turn and retry metadata instead of sending incomplete context", async () => {
  let now = 0;
  const error = Object.assign(pending(), { userMessage: { id: 42 } });
  const run = createMemoryReadinessRunner({ scopeCoordinator: createChatScopeCoordinator(), timeoutMs: 100,
    pollIntervalMs: 25, now: () => now, wait: async ms => { now += ms; },
    memory: { requestContextCatchup() {} },
  });
  await assert.rejects(run({ key: "1:p", execute() { throw error; } }), failure =>
    failure === error && failure.userMessage.id === 42 && failure.retryAfterMs === 25);
});

test("client cancellation releases a coverage wait", { timeout: 2000 }, async () => {
  const scopeCoordinator = createChatScopeCoordinator();
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const run = createMemoryReadinessRunner({ scopeCoordinator, timeoutMs: 1000,
    memory: { requestContextCatchup() { started.resolve(); } },
  });
  const result = run({ key: "1:p", signal: controller.signal, execute() { throw pending(); } });
  const rejected = assert.rejects(result, /disconnected/);
  await started.promise;
  controller.abort(new Error("disconnected"));
  await rejected;
  await scopeCoordinator.waitForIdle();
});
