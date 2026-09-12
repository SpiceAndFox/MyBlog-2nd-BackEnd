const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime } = require("../../../modules/memory/application/runtime");
const { TARGET_KEYS, assertMemoryState } = require("../../../modules/memory/contracts");
const { createSendMessageUseCase } = require("../../../modules/chat/application/sendMessage");
const { createChatScopeCoordinator } = require("../../../modules/chat/application/scopeCoordinator");
const { createSessionUseCases } = require("../../../modules/chat/application/sessions");
const { store, config } = require("../support/recovery-harness");
const { withLibrarianRepositoryStubs, createMemoryTestConfig } = require("../support/memory-builders");

function fixture(providerAdapter, { missingState = false, rebuilding = false, invalidState = false, complete } = {}) {
  const memory = store();
  if (invalidState) delete memory.inspect.state.current;
  if (rebuilding) {
    memory.inspect.state.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map(key => [key, 1]));
    for (const key of TARGET_KEYS) memory.inspect.statuses.set(key, {
      target_key: key, source_generation: 0, status: "rebuilding", rebuild_boundary_message_id: 1,
    });
  }
  const chat = createChatScopeCoordinator();
  let operation = null;
  let initialized = !missingState;
  let rawExists = true;
  let stateRecovery;
  let userGeneration;
  const repositories = withLibrarianRepositoryStubs({
    ...memory.repositories,
    state: {
      ...memory.repositories.state,
      async getState(...args) {
        if (!initialized) return null;
        const state = await memory.repositories.state.getState(...args);
        assertMemoryState(state);
        return state;
      },
      getRawState: memory.repositories.state.getState,
      async initializeRevisionZero() { initialized = true; return memory.repositories.state.getState(); },
    },
    source: { ...memory.repositories.source, async countAfter(_u, _p, cursor) { return cursor < 1 ? 1 : 0; }, async getBoundary() { return 1; } },
    sourceWriteGuard: { async lockScope() {}, async lockAndRead() { return { sourceGeneration: memory.inspect.state.meta.sourceGeneration, privacyPending: operation && operation.status !== "completed" }; } },
    runtime: {
      ...memory.repositories.runtime,
      async cancelNonTerminalTasks() {
        for (const task of memory.inspect.tasks.values()) if (!["succeeded", "failed", "cancelled"].includes(task.status)) task.status = "cancelled";
      },
    },
    audit: {
      ...memory.repositories.audit,
      async getRecoveryHead() { return { revision: 0, sourceGeneration: 0 }; },
      async listSnapshotsForRecovery() { return []; },
    },
    privacy: {
      async getOperation() { return operation; },
      async hasIncompleteOperation() { return Boolean(operation && operation.status !== "completed"); },
      async listIncompleteOperations() { return operation && operation.status !== "completed" ? [operation] : []; },
      async purgeDerivedHistory() { memory.inspect.tasks.clear(); memory.inspect.groups.clear(); memory.inspect.snapshots.length = 0; },
      async upsertOperation(_u, _p, value) { operation = { ...value, userId: 1, presetId: "default" }; },
      async updateOperation(_u, _p, changes) { Object.assign(operation, changes); },
    },
  });
  const errors = [];
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({ ...config, enabled: true,
      targets: Object.fromEntries(TARGET_KEYS.map(key => [key, config.targets[key] || { lagThreshold: 10, contextWindow: 20 }])) }), repositories, providerAdapter,
    enqueueByKey: chat.enqueueByKey, onBackgroundError: error => errors.push(error),
  });
  const session = { id: 5, preset_id: "default", settings: {} };
  const chatRepository = {
    async getSession() { return session; }, async getTrashedSession() { return rawExists ? session : null; },
    async updateSessionSettings() { return session; }, async touchSession() { return session; },
    async createUserMessage(_u, _s, _content, options) {
      userGeneration = options.sourceGeneration;
      return { created: true, message: { id: 2, turn_id: "turn", content: "new question" } };
    },
    async getAssistantForUserMessage() { return null; },
    async createAssistantMessageForTurn(_u, _s, _parent, _turn, _content, options) {
      if (options.sourceGeneration !== userGeneration) throw Object.assign(new Error("stale turn"), { code: "CHAT_TURN_STALE" });
      return { message: { id: 3, content: "answer" } };
    },
    async deleteSessionPermanently() { rawExists = false; return { id: 5, firstMessageId: 20 }; },
  };
  for (const method of ["listSessions", "listTrashedSessions", "createSession", "getSessionMessageIdRange", "trashSession", "restoreSession", "listMessages"]) {
    chatRepository[method] = async () => null;
  }
  const settings = {
    getSessionPresetId: () => "default", isSessionEditableToday: () => true,
    sanitize: () => ({}), merge: () => ({}), normalize: value => value, validate: () => null,
    resolvePresetForSession: async () => ({ presetId: "default", preset: {} }),
    resolveProviderModel: () => ({ providerId: "test", modelId: "test", providerDefinition: {} }),
  };
  const send = createSendMessageUseCase({
    chatRepository, settings, memory: runtime, scopeCoordinator: chat, transaction: { run: repositories.withTransaction },
    compileContext: async () => {
      if (invalidState) stateRecovery = runtime.scheduleStateRecovery({ userId: 1, presetId: "default" });
      else await runtime.ensureScope({ userId: 1, presetId: "default" });
      return { messages: [{ role: "user", content: "new question" }] };
    },
    llm: { complete: complete || (async () => ({ content: "answer" })), createStreamResponse() {}, streamDeltas() {} },
    rag: { requestTurnIndexing() {} }, gist: { requestGeneration() {} },
    logger: { debug() {}, error() {} }, timeoutMs: 1000,
  });
  const sessions = createSessionUseCases({ chatRepository, settings, memory: runtime, scopeCoordinator: chat });
  return { runtime, send, sessions, memory, errors, get stateRecovery() { return stateRecovery; }, get operation() { return operation; }, get rawExists() { return rawExists; } };
}

test("actual chat completes while the runtime proposer is pending; permanent delete aborts it before committing", { timeout: 3000 }, async () => {
  const started = Promise.withResolvers();
  const provider = Promise.withResolvers();
  const harness = fixture({ propose(_envelope, { signal }) { started.resolve(signal); return provider.promise; } });
  const background = harness.runtime.processScope(1, "default");
  const signal = await started.promise;
  const sent = await harness.send({ userId: 1, sessionId: 5, content: "new question", idempotencyKey: "send-1" });
  assert.equal(sent.assistantMessage.content, "answer");
  assert.equal(signal.aborted, false);
  const deleted = await harness.sessions.removePermanently({ userId: 1, sessionId: 5 });
  assert.equal(deleted.privacy.rawMutationCommitted, true);
  assert.equal(harness.rawExists, false);
  assert.equal(signal.aborted, true);
  await background;
  provider.resolve({ status: "ok", output: { outcome: "noop" } });
  await new Promise(setImmediate);
  await harness.runtime.reconcilePrivacyDeletes();
  assert.equal(harness.operation.status, "completed");
  assert.equal(harness.memory.inspect.state.meta.targetCursors.todos, 0);
  assert.equal(harness.memory.inspect.tasks.size, 0, "late output cannot recreate purged task history");
  await harness.runtime.shutdown();
  assert.deepEqual(harness.errors, []);
});

test("permanent deletion initializes a missing authority without invoking a proposer", { timeout: 3000 }, async () => {
  const harness = fixture({ propose() { throw new Error("unexpected proposer"); } }, { missingState: true });
  const result = await harness.sessions.removePermanently({ userId: 1, sessionId: 5 });
  assert.equal(result.privacy.rawMutationCommitted, true);
  await harness.runtime.reconcilePrivacyDeletes();
  assert.equal(harness.operation.status, "completed");
  assert.equal(harness.memory.inspect.state.meta.sourceGeneration, 1);
  await harness.runtime.shutdown();
  assert.deepEqual(harness.errors, []);
});

test("first chat initializes Memory without re-entering its own send queue", { timeout: 3000 }, async () => {
  const harness = fixture({ propose() { return new Promise(() => {}); } }, { missingState: true });
  const result = await harness.send({ userId: 1, sessionId: 5, content: "hello", idempotencyKey: "first" });
  assert.equal(result.kind, "completed");
  await harness.runtime.shutdown();
  assert.deepEqual(harness.errors, []);
});

test("a Librarian rebuild can be interrupted by deletion without delaying its raw commit", { timeout: 3000 }, async () => {
  const started = Promise.withResolvers();
  const provider = Promise.withResolvers();
  const harness = fixture({ propose(envelope, { signal }) {
    assert.equal(envelope.task.targetKey, "librarian");
    started.resolve(signal); return provider.promise;
  } }, { rebuilding: true });
  await harness.runtime.rebuildScope(1, "default");
  const signal = await started.promise;
  const result = await harness.sessions.removePermanently({ userId: 1, sessionId: 5 });
  assert.equal(result.privacy.rawMutationCommitted, true);
  assert.equal(signal.aborted, true);
  assert.equal(harness.rawExists, false);
  await harness.runtime.shutdown();
  provider.resolve({ status: "ok", output: { outcome: "noop" } });
  await new Promise(setImmediate);
  assert.deepEqual(harness.errors, []);
});

test("state recovery waits for the active reply before switching generation, then rebuilds off the chat lane", { timeout: 3000 }, async t => {
  const replyStarted = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const proposerStarted = Promise.withResolvers();
  const harness = fixture({ propose() { proposerStarted.resolve(); return new Promise(() => {}); } }, {
    invalidState: true,
    complete() { replyStarted.resolve(); return reply.promise; },
  });
  t.after(async () => { reply.resolve({ content: "answer" }); await harness.runtime.shutdown(); });
  const sent = harness.send({ userId: 1, sessionId: 5, content: "hello", idempotencyKey: "recover" });
  void sent.catch(() => {});
  await replyStarted.promise;
  await new Promise(setImmediate);
  assert.equal(harness.memory.inspect.state.meta.sourceGeneration, 0, "an in-flight reply keeps its source generation");
  reply.resolve({ content: "answer" });
  assert.equal((await sent).kind, "completed");
  await Promise.race([proposerStarted.promise, harness.stateRecovery.then(result => {
    throw new Error(`Recovery exited before invoking the proposer: ${JSON.stringify(result)}`);
  })]);
  assert.equal(harness.memory.inspect.state.meta.sourceGeneration, 1);
  assert.equal((await harness.send({ userId: 1, sessionId: 5, content: "next", idempotencyKey: "recover-next" })).kind, "completed");
  await harness.runtime.shutdown();
  await harness.stateRecovery;
  assert.deepEqual(harness.errors, []);
});

test("a Memory worker schedules corrupt-state recovery without waiting on its own mutation barrier", { timeout: 3000 }, async t => {
  const proposerStarted = Promise.withResolvers();
  const harness = fixture({ propose() { proposerStarted.resolve(); return new Promise(() => {}); } }, { invalidState: true });
  t.after(() => harness.runtime.shutdown());
  const result = await harness.runtime.processScope(1, "default");
  assert.equal(result.status, "interrupted");
  await proposerStarted.promise;
  assert.equal(harness.memory.inspect.state.meta.sourceGeneration, 1);
  await harness.runtime.shutdown();
  assert.deepEqual(harness.errors, []);
});

test("state recovery cannot switch generation or rebuild while privacy cleanup remains incomplete", { timeout: 3000 }, async t => {
  const harness = fixture({ propose() { throw new Error("unexpected proposer"); } });
  t.after(() => harness.runtime.shutdown());
  await harness.sessions.removePermanently({ userId: 1, sessionId: 5 });
  const generation = harness.memory.inspect.state.meta.sourceGeneration;
  // execute returned after its source transaction, before the setImmediate
  // privacy continuation. The durable fence must also cover state recovery.
  const result = await harness.runtime.scheduleStateRecovery({ userId: 1, presetId: "default" });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "privacy_delete_pending");
  assert.equal(harness.memory.inspect.state.meta.sourceGeneration, generation);
  await harness.runtime.reconcilePrivacyDeletes();
  assert.equal(harness.operation.status, "completed");
});
