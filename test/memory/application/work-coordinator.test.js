const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryWorkCoordinator } = require("../../../modules/memory/application/workCoordinator");
const { createChatScopeCoordinator } = require("../../../modules/chat/application/scopeCoordinator");
const { createProviderAdmission, admissionControlledAdapter } = require("../../../modules/memory/application/providerAdmission");

const deferred = () => Promise.withResolvers();

test("a blocked Memory provider does not block chat; mutation drains cancellation and ignores late results", { timeout: 2000 }, async () => {
  const chat = createChatScopeCoordinator();
  const memory = createMemoryWorkCoordinator({ enqueueMutation: chat.enqueueByKey });
  const provider = deferred();
  const started = deferred();
  const writes = [];
  const adapter = admissionControlledAdapter({ propose(_envelope, { signal }) {
    started.resolve(signal);
    return provider.promise; // Deliberately ignores cancellation.
  } }, createProviderAdmission({ concurrency: 1, queueMax: 2 }));
  const job = memory.enqueue("1:default", async ({ signal }) => {
    const result = await adapter.propose({}, { signal });
    if (result.status === "ok") writes.push("memory");
    writes.push("memory-exit");
    return result;
  });
  const signal = await started.promise;
  await chat.enqueueByKey("1:default", () => writes.push("chat"));
  assert.equal(signal.aborted, false, "ordinary chat does not cancel the proposer");
  const obsolete = memory.enqueue("1:default", () => writes.push("obsolete-job"));
  await memory.mutate("1:default", () => writes.push("delete"));
  assert.equal(signal.aborted, true);
  assert.deepEqual(writes, ["chat", "memory-exit", "delete"]);
  assert.equal((await job).reason, "operation_interrupted");
  assert.equal((await obsolete).status, "interrupted");
  provider.resolve({ status: "ok" });
  await new Promise(setImmediate);
  assert.deepEqual(writes, ["chat", "memory-exit", "delete"]);
  await memory.shutdown();
});

test("mutations reserve source order immediately and block new Memory work until commit", async () => {
  const chat = createChatScopeCoordinator();
  const memory = createMemoryWorkCoordinator({ enqueueMutation: chat.enqueueByKey });
  const gate = deferred();
  const events = [];
  const sending = chat.enqueueByKey("1:p", () => gate.promise);
  const mutation = memory.mutate("1:p", async () => events.push("mutation"));
  const following = chat.enqueueByKey("1:p", () => events.push("next-chat"));
  const background = memory.enqueue("1:p", () => events.push("memory"));
  await memory.enqueue("2:p", () => events.push("other-scope"));
  assert.deepEqual(events, ["other-scope"]);
  gate.resolve();
  await Promise.all([sending, mutation, following, background]);
  assert.equal(events.indexOf("mutation") < events.indexOf("next-chat"), true);
  assert.equal(events.indexOf("mutation") < events.indexOf("memory"), true);
  await memory.shutdown();
});

test("shutdown interrupts providers and an admission waiter without invoking the queued provider", { timeout: 2000 }, async () => {
  const memory = createMemoryWorkCoordinator();
  const started = deferred();
  const never = new Promise(() => {});
  const calls = [];
  const adapter = admissionControlledAdapter({ propose(envelope) {
    calls.push(envelope.id); started.resolve(); return never;
  } }, createProviderAdmission({ concurrency: 1, queueMax: 2 }));
  const first = memory.enqueue("1:p", ({ signal }) => adapter.propose({ id: 1 }, { signal }));
  await started.promise;
  const second = memory.enqueue("2:p", ({ signal }) => adapter.propose({ id: 2 }, { signal }));
  await new Promise(setImmediate);
  await memory.shutdown();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [1]);
  await assert.rejects(memory.mutate("1:p", () => {}), { code: "MEMORY_RUNTIME_SHUTTING_DOWN" });
});
