const test = require("node:test");
const assert = require("node:assert/strict");
const { createScopeCoordinator } = require("../../services/chat/scopeCoordinator");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("chat scope coordinator serializes sends across sessions sharing one preset", async () => {
  const coordinator = createScopeCoordinator();
  const gate = deferred();
  const events = [];
  const first = coordinator.enqueueByKey("7:companion", async () => {
    events.push("send-1-start");
    await gate.promise;
    events.push("send-1-end");
  }, { cancellable: true });
  const second = coordinator.enqueueByKey("7:companion", async () => {
    events.push("send-2-start");
    events.push("send-2-end");
  }, { cancellable: true });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["send-1-start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["send-1-start", "send-1-end", "send-2-start", "send-2-end"]);
});

test("source mutation cancels both active and queued generations before taking the lane", async () => {
  const coordinator = createScopeCoordinator();
  const active = coordinator.enqueueByKey("7:companion", ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { cancellable: true });
  const queuedRan = [];
  const queued = coordinator.enqueueByKey("7:companion", async () => queuedRan.push(true), { cancellable: true });

  await new Promise((resolve) => setImmediate(resolve));
  const reason = Object.assign(new Error("edited"), { code: "CHAT_SCOPE_MUTATED" });
  assert.equal(coordinator.cancelByKey("7:companion", reason), 2);
  await assert.rejects(active, { code: "CHAT_SCOPE_MUTATED" });
  await assert.rejects(queued, { code: "CHAT_SCOPE_MUTATED" });
  const mutation = await coordinator.enqueueByKey("7:companion", async () => "mutated");
  assert.equal(mutation, "mutated");
  assert.deepEqual(queuedRan, []);
});
