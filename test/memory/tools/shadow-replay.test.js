const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { buildNormalEnvelope } = require("../../../modules/memory/application/envelope");
const { createMemoryTaskShadowReplay } = require("../../../modules/memory/application/taskShadowReplay");
const { createMemoryTestConfig, sha256 } = require("../support/memory-builders");

const TASK_ID = "12345678-1234-5678-9234-123456789abc";

function fixture() {
  const state = createInitialMemoryState();
  state.meta.sourceGeneration = 4;
  const messages = [
    { id: 1078, role: "user", content: "明天做三明治", createdAt: "2026-07-18T10:00:00.000Z" },
    { id: 1079, role: "assistant", content: "好呀", createdAt: "2026-07-18T10:00:01.000Z" },
    { id: 1080, role: "user", content: "明天还要做草莓大福", createdAt: "2026-07-18T10:00:02.000Z" },
  ].map((message) => ({ ...message, contentKind: "raw", contentHash: sha256(message.content) }));
  const baseConfig = createMemoryTestConfig({
    targets: { todos: { lagThreshold: 3, contextWindow: 64 } },
  });
  const config = {
    ...baseConfig,
    enabled: true,
    provider: { adapter: "deepseek-strict-tools", model: "test-model", thinkingMode: "disabled" },
  };
  const envelope = buildNormalEnvelope({
    userId: 1,
    presetId: "Alice",
    state,
    intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 1077 },
    messages,
    now: new Date("2026-07-18T10:01:00.000Z"),
    userTimeZone: "Asia/Shanghai",
    taskId: TASK_ID,
    tickId: 99,
    config,
  });
  const proposal = {
    tickId: 99,
    proposer: "todoProposer",
    sectionResults: {
      todos: {
        status: "changes",
        changes: [
          {
            action: "add", text: "做三明治", actor: "user", requester: "user",
            dueAt: { mode: "relative", days: 1 }, anchorMessageId: 1078, evidenceMessageIds: [1078],
          },
          {
            action: "add", text: "做草莓大福", actor: "user", requester: "user",
            dueAt: { mode: "relative", days: 1 }, anchorMessageId: 1080, evidenceMessageIds: [1080],
          },
        ],
      },
    },
  };
  return { state, messages, config, envelope, proposal };
}

test("task shadow replay is read-only and reports schema, Reducer, and provenance", async () => {
  const { state, messages, config, envelope, proposal } = fixture();
  const calls = [];
  const repositories = {
    runtime: {
      getTask: async (taskId) => {
        calls.push(["getTask", taskId]);
        return {
          task_id: taskId,
          task_type: "normal",
          status: "succeeded",
          stage: "committed",
          task_payload: envelope,
          stage_payload: { normalContextWindow: 64, semanticResult: proposal, semanticInputVariant: "base" },
        };
      },
      updateTask: async () => { throw new Error("must not write task"); },
    },
    audit: {
      getSnapshot: async (userId, presetId, revision) => {
        calls.push(["getSnapshot", userId, presetId, revision]);
        return { source_generation: 4, revision: 0, state };
      },
      insertSnapshot: async () => { throw new Error("must not write snapshot"); },
      insertEvents: async () => { throw new Error("must not write events"); },
    },
    source: {
      getByIds: async (userId, presetId, ids) => {
        calls.push(["getByIds", userId, presetId, ids]);
        return messages.filter((message) => ids.includes(message.id)).map((message) => ({ ...message, userId, presetId }));
      },
    },
    state: { writeState: async () => { throw new Error("must not write state"); } },
  };
  const replay = createMemoryTaskShadowReplay({
    repositories,
    config,
    providerAdapter: { propose: async () => ({ status: "ok", model: "test-model", usage: { input_tokens: 10, output_tokens: 20 }, output: proposal }) },
    promptLoader: async () => "current prompt",
  });

  const report = await replay.replay(TASK_ID);

  assert.equal(report.status, "completed");
  assert.equal(report.mode, "read_only_task_shadow_replay");
  assert.equal(report.task.targetKey, "todos");
  assert.deepEqual(report.task.sourceBoundary, { cursorBefore: 1077, targetMessageId: 1080 });
  assert.match(report.provenance.promptHash, /^sha256:/);
  assert.match(report.provenance.outputSchemaHash, /^sha256:/);
  assert.equal(report.replay.summary.changeCount, 2);
  assert.equal(report.replay.schemaValidation.passed, true);
  assert.equal(report.replay.reducerPreflight.status, "passed");
  assert.deepEqual(report.replay.reducerPreflight.decisions, { accepted: 2, rejected: 0, noop: 0, deferred: 0 });
  assert.equal(report.replay.reducerPreflight.events.filter((event) => event.decision === "accepted").length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(report.replay, "alice"), false);
  assert.deepEqual(calls.map(([name]) => name), ["getTask", "getSnapshot", "getByIds"]);
});

test("task shadow replay returns provider schema failures without attempting Reducer preflight", async () => {
  const { config, envelope } = fixture();
  let snapshots = 0;
  const replay = createMemoryTaskShadowReplay({
    repositories: {
      runtime: { getTask: async () => ({ task_payload: envelope, stage_payload: null }) },
      audit: { getSnapshot: async () => { snapshots += 1; return null; } },
      source: { getByIds: async () => [] },
    },
    config,
    providerAdapter: {
      propose: async () => ({
        status: "error",
        reason: "output_schema_invalid",
        detail: { boundary: "output", errors: [{ path: "$.sectionResults", message: "is invalid" }] },
      }),
    },
    promptLoader: async () => "current prompt",
  });

  const report = await replay.replay(TASK_ID);
  assert.equal(report.status, "provider_error");
  assert.equal(report.replay.schemaValidation.passed, false);
  assert.equal(report.replay.reducerPreflight, null);
  assert.equal(Object.prototype.hasOwnProperty.call(report.replay, "alice"), false);
  assert.equal(snapshots, 0);
});

test("task shadow replay mirrors the bounded schema repair before preflight", async () => {
  const { state, messages, config: baseConfig, envelope, proposal } = fixture();
  const config = { ...baseConfig, providerRecovery: { schemaInvalidRetryMax: 1 } };
  const options = [];
  const replay = createMemoryTaskShadowReplay({
    repositories: {
      runtime: { getTask: async () => ({ task_payload: envelope, stage_payload: null }) },
      audit: { getSnapshot: async () => ({ source_generation: 4, state }) },
      source: { getByIds: async (_u, _p, ids) => messages.filter((message) => ids.includes(message.id)).map((message) => ({ ...message, userId: 1, presetId: "Alice" })) },
    },
    config,
    providerAdapter: {
      async propose(_envelope, adapterOptions) {
        options.push(adapterOptions);
        if (options.length === 1) {
          return {
            status: "error",
            reason: "output_schema_invalid",
            detail: { boundary: "output", errors: [{ path: "$.tickId", message: "is required" }] },
          };
        }
        return { status: "ok", output: proposal };
      },
    },
    promptLoader: async () => "current prompt",
  });

  const report = await replay.replay(TASK_ID);
  assert.equal(report.status, "completed");
  assert.equal(report.replay.providerAttempts.length, 2);
  assert.equal(options[0].repairFeedback, null);
  assert.deepEqual(options[1].repairFeedback.errors, [{ path: "$.tickId", message: "is required" }]);
});

test("task shadow replay reconstructs expanded input with the immutable base ref map", async () => {
  const { state, config, envelope } = fixture();
  const older = {
    id: 1076,
    role: "user",
    content: "更早的上下文",
    createdAt: "2026-07-18T09:59:59.000Z",
  };
  const expandedMessages = [older, ...envelope.artifact.publicInput.messages];
  const expandedArtifact = {
    publicInput: { ...structuredClone(envelope.artifact.publicInput), messages: expandedMessages },
    messageMeta: {
      ...structuredClone(envelope.artifact.messageMeta),
      "1076": { role: "user", createdAt: older.createdAt, contentHash: sha256(older.content) },
    },
  };
  const unableResult = {
    tickId: envelope.task.tickId,
    proposer: envelope.task.proposer,
    sectionResults: { todos: { status: "unable_to_decide" } },
  };
  let providerEnvelope;
  const replay = createMemoryTaskShadowReplay({
    repositories: {
      runtime: { getTask: async () => ({
        task_payload: envelope,
        context_expansion_attempt: 1,
        stage_payload: { expandedArtifact, unableResult },
      }) },
      audit: { getSnapshot: async () => ({ source_generation: 4, state }) },
      source: { getByIds: async () => { throw new Error("unable replay must not compile"); } },
    },
    config,
    providerAdapter: { propose: async (effectiveEnvelope) => {
      providerEnvelope = effectiveEnvelope;
      return { status: "ok", output: unableResult };
    } },
    promptLoader: async () => "current prompt",
  });

  const report = await replay.replay(TASK_ID);
  assert.equal(report.status, "completed");
  assert.equal(report.task.semanticInputVariant, "expanded");
  assert.equal(report.baseline.resultKind, "unableResult");
  assert.deepEqual(providerEnvelope.artifact.refMap, envelope.artifact.refMap);
  assert.deepEqual(providerEnvelope.artifact.publicInput.messages.map((message) => message.id), [1076, 1078, 1079, 1080]);
});
