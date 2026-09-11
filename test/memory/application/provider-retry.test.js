const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { OUTPUT_REPAIR_POLICY_VERSION } = require("../../../modules/memory/application/outputRepair");
const { recoveryScenario, fixedNow, config, intent, store } = require("../support/recovery-harness");

test("recovery fixture applies bounded retry backoff and halts only the failing target", async () => {
  const data = store();
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  for (const expected of recoveryScenario.providerErrors) {
    const result = await pipeline.recordAdapterError(envelope, { status: "error", reason: expected.reason });
    const target = data.inspect.statuses.get("todos");
    assert.equal(target.status, expected.expectedStatus);
    assert.equal(target.consecutive_errors, expected.expectedConsecutiveErrors);
    assert.equal(result.notBefore === null ? null : Date.parse(result.notBefore) - fixedNow.getTime(), expected.expectedDelayMs);
  }
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.snapshots.length, 0);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), recoveryScenario.providerErrors.map((entry) => entry.reason));
});

test("provider retryMax halts even before the broader consecutive-error limit", async () => {
  const data = store();
  const strictConfig = { ...config, providerRecovery: { ...config.providerRecovery, retryMax: 0, haltAfterConsecutiveErrors: 3 } };
  const pipeline = createNormalWritePipeline({ observer: {}, providerAdapter: {}, repositories: data.repositories, config: strictConfig, now: () => fixedNow });
  const envelope = await pipeline.createTask(1, "default", intent);
  const result = await pipeline.recordAdapterError(envelope, { status: "error", reason: "llm_call_failed" });
  assert.equal(result.halted, true);
  assert.equal(result.consecutiveErrors, 1);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
});

test("output schema invalid durably persists the rejected output and commits a valid repair", async () => {
  const data = store();
  let calls = 0;
  const repairFeedbacks = [];
  const rejectedOutputs = [];
  const rejectedOutput = { sectionStatuses: { todos: "changes" }, changes: [] };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope, options) => {
      calls += 1;
      repairFeedbacks.push(options?.repairFeedback ?? null);
      rejectedOutputs.push(options?.rejectedOutput);
      if (calls === 1) return { status: "error", reason: "output_schema_invalid", rejectedOutput, detail: { boundary: "output", errors: [{ path: "$.sectionResults", message: "is invalid" }] } };
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "noop" } } } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "committed");
  assert.equal(calls, 2);
  assert.equal(repairFeedbacks[0], null);
  assert.equal(repairFeedbacks[1].policyVersion, OUTPUT_REPAIR_POLICY_VERSION);
  assert.equal(rejectedOutputs[0], undefined);
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.deepEqual(repairFeedbacks[1].errors, [{
    code: "CONTRACT_INVALID",
    path: "$.sectionResults",
    message: "is invalid",
  }]);
  assert.equal(task.attempt, 1);
  assert.deepEqual(task.stage_payload.schemaRepairFeedback, repairFeedbacks[1]);
  assert.deepEqual(task.stage_payload.schemaRejectedOutputs, [{
    attempt: 0,
    available: true,
    utf8Bytes: Buffer.byteLength(JSON.stringify(rejectedOutput), "utf8"),
    output: rejectedOutput,
  }]);
  assert.equal(data.inspect.ops[0].outcome, "output_schema_invalid_retry");
  assert.deepEqual(data.inspect.ops[0].detail.repairFeedback, repairFeedbacks[1]);
  assert.equal(JSON.stringify(data.inspect.ops[0]).includes(JSON.stringify(rejectedOutput)), false);
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
});

test("a second output schema invalid halts without a third provider call", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async () => {
      calls += 1;
      return {
        status: "error",
        reason: "output_schema_invalid",
        rejectedOutput: { invalidAttempt: calls },
        detail: { boundary: "output", errors: [{ path: "$" }] },
      };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.halted, true);
  assert.equal(calls, 2);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), ["output_schema_invalid_retry", "semantic_schema_invalid"]);
  const task = [...data.inspect.tasks.values()][0];
  assert.deepEqual(task.stage_payload.schemaRejectedOutputs.map((entry) => entry.output), [
    { invalidAttempt: 1 },
    { invalidAttempt: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(data.inspect.ops), /invalidAttempt/);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
});

test("transport and semantic schema repairs have separate bounded allowances", async () => {
  const data = store();
  let calls = 0;
  const feedbacks = [];
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async (envelope, options) => {
      calls += 1;
      feedbacks.push(options?.repairFeedback ?? null);
      if (calls === 1) {
        return {
          status: "error",
          reason: "output_schema_invalid",
          rejectedOutput: '{"sectionStatuses":',
          detail: {
            boundary: "output",
            transportError: "content_invalid_json",
            errors: [{ path: "$", message: "must be an object" }],
          },
        };
      }
      if (calls === 2) {
        return {
          status: "error",
          reason: "output_schema_invalid",
          rejectedOutput: { sectionStatuses: { todos: "changes" }, changes: [{ target: "not-an-enum" }] },
          detail: {
            boundary: "output",
            errors: [{ code: "WRITABLE_REF_INVALID", path: "$.changes[0].target", message: "invalid target" }],
          },
        };
      }
      return {
        status: "ok",
        output: {
          tickId: envelope.task.tickId,
          proposer: envelope.task.proposer,
          sectionResults: { todos: { status: "noop" } },
        },
      };
    } },
  });

  const result = await pipeline.processIntent(1, "default", intent);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "committed");
  assert.equal(calls, 3);
  assert.equal(task.stage_payload.transportInvalidAttempts, undefined);
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.deepEqual(task.stage_payload.schemaRejectedOutputs.map((entry) => entry.attempt), [0, 1]);
  assert.equal(feedbacks[1].errors[0].code, "TOOL_ARGUMENTS_INVALID_JSON");
  assert.equal(feedbacks[2].errors[0].code, "WRITABLE_REF_INVALID");
});

test("transport repair can be disabled without disabling semantic repair", async () => {
  const data = store();
  let calls = 0;
  const strictConfig = {
    ...config,
    providerRecovery: {
      ...config.providerRecovery,
      transportInvalidRetryMax: 0,
    },
  };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config: strictConfig, now: () => fixedNow,
    providerAdapter: { propose: async () => {
      calls += 1;
      return {
        status: "error",
        reason: "output_schema_invalid",
        rejectedOutput: '{"broken":',
        detail: {
          boundary: "output",
          validationLayer: "transport",
          transportError: "content_invalid_json",
          errors: [{ path: "$", message: "must be an object" }],
        },
      };
    } },
  });

  const result = await pipeline.processIntent(1, "default", intent);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.halted, true);
  assert.equal(calls, 1);
  assert.equal(task.stage_payload.transportInvalidAttempts, undefined);
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.equal(task.stage_payload.schemaRejectedOutputs.length, 1);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), ["output_schema_invalid"]);
  assert.equal(data.inspect.ops[0].detail.validationLayer, "transport");
});

test("input schema invalid never retries", async () => {
  const data = store();
  let calls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { propose: async () => {
      calls += 1;
      return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: [{ path: "$.task" }] } };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.halted, true);
  assert.equal(calls, 1);
  assert.deepEqual(data.inspect.ops.map((entry) => entry.outcome), ["output_schema_invalid"]);
});

test("schema retry allowance survives re-entry within the same executor", async () => {
  const data = store();
  let calls = 0;
  let interrupted = true;
  const repairFeedbacks = [];
  const rejectedOutputs = [];
  const rejectedOutput = { malformed: "durable" };
  const providerAdapter = { propose: async (_envelope, options) => {
    calls += 1;
    repairFeedbacks.push(options?.repairFeedback ?? null);
    rejectedOutputs.push(options?.rejectedOutput);
    if (calls === 1) return { status: "error", reason: "output_schema_invalid", rejectedOutput, detail: { boundary: "output", errors: [{ path: "$", message: "broken output" }] } };
    if (interrupted) throw new Error("simulated process interruption");
    return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$" }] } };
  } };
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => fixedNow, providerAdapter });
  const envelope = await pipeline.createTask(1, "default", intent);
  await assert.rejects(() => pipeline.processEnvelope(envelope), /simulated process interruption/);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).stage_payload.schemaInvalidAttempts, undefined);
  interrupted = false;
  const result = await pipeline.processEnvelope(envelope);
  assert.equal(result.halted, true);
  assert.equal(calls, 3, "recovery may call once but must not grant another schema retry");
  assert.equal(repairFeedbacks[0], null);
  assert.deepEqual(repairFeedbacks[1], repairFeedbacks[2], "recovery must reuse the durable repair feedback");
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.deepEqual(rejectedOutputs[2], rejectedOutput, "recovery must replay the durable rejected output");
  assert.deepEqual(repairFeedbacks[2].errors, [{
    code: "CONTRACT_INVALID",
    path: "$",
    message: "broken output",
  }]);
});

test("unable_to_decide expands once, then commits one cursor-only revision idempotently", async () => {
  const data = store();
  const outputFor = (envelope) => ({ tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: { todos: { status: "unable_to_decide" } } });
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => fixedNow,
    providerAdapter: { async propose(envelope) { return { status: "ok", output: outputFor(envelope) }; } },
  });
  const envelope = await pipeline.createTask(1, "default", intent);
  const first = await pipeline.processEnvelope(envelope);
  const second = await pipeline.processEnvelope(envelope);
  const duplicate = await pipeline.processEnvelope(envelope);
  assert.equal(first.status, recoveryScenario.unableToDecide.firstStatus);
  assert.equal(second.status, recoveryScenario.unableToDecide.secondStatus);
  assert.equal(duplicate.duplicate, true);
  assert.equal(data.inspect.state.meta.revision, recoveryScenario.unableToDecide.revisionAfter);
  assert.equal(data.inspect.state.meta.targetCursors.todos, recoveryScenario.unableToDecide.cursorAfter);
  assert.equal(data.inspect.groups.size, 1);
  assert.equal(data.inspect.events.length, 0);
  assert.equal(data.inspect.snapshots.length, 1);
  const task = data.inspect.tasks.get(envelope.task.taskId);
  assert.equal(task.stage_payload.semanticResult, undefined);
  assert.equal(task.stage_payload.compiledProposal, undefined);
  assert.equal(task.stage_payload.unableResult.sectionResults.todos.status, "unable_to_decide");
});


test("an oversized append result retains repair history and cannot partially commit on restart", async () => {
  const data = store();
  const [original] = await data.repositories.source.getByIds();
  const next = { ...original, id: 2 };
  data.repositories.source.getObservedWindow = async () => [next];
  data.repositories.source.getByIds = async (_u, _p, ids) => [original, next].filter(m => ids.includes(m.id));
  const state = await data.repositories.state.getState();
  state.meta.targetCursors.episodes = 1;
  state.working.recentEpisodes = [{ id: "arc", text: "旧".repeat(590), sourceRefs: [{ messageId: 1, contentHash: original.contentHash }], createdAtMessageId: 1, updatedAtMessageId: 1 }];
  await data.repositories.state.writeState(1, "default", state);
  const settings = { ...config, targets: { episodes: { lagThreshold: 1, contextWindow: 2 } } };
  let calls = 0;
  const providerAdapter = { async propose(envelope, options) {
    calls++;
    if (calls === 2) assert.match(JSON.stringify(options.repairFeedback), /TEXT_LENGTH_EXCEEDED/);
    return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "changes", changes: [{ action: "append", ref: "E1", text: "新".repeat(20), evidenceMessageIds: [2] }] }, milestones: { status: "noop" } } } };
  } };
  const make = () => createNormalWritePipeline({ observer: {}, repositories: data.repositories, config: settings, now: () => fixedNow, providerAdapter });
  const pipeline = make();
  const envelope = await pipeline.createTask(1, "default", { targetKey: "episodes", proposer: "episodeProposer", targetSections: ["recentEpisodes", "milestones"], trigger: { type: "lagThreshold" } });
  const result = await pipeline.processEnvelope(envelope);
  assert.equal(result.halted, true);
  assert.equal(calls, 2);
  assert.deepEqual(data.inspect.state, state);
  assert.equal(data.inspect.events.length, 0);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).stage_payload.schemaInvalidAttempts, undefined);
  await make().processEnvelope(envelope);
  assert.equal(calls, 2);
  assert.deepEqual(data.inspect.state, state);
});
