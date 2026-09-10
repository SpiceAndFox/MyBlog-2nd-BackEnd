const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { config, fixedNow, intent, store } = require("../support/recovery-harness");

const adapter = invokeStructured => createMemoryProviderAdapter({ promptLoader: async () => "todo prompt", invokeStructured });
const pipeline = (data, providerAdapter, settings = config) => createNormalWritePipeline({
  observer: {}, repositories: data.repositories, providerAdapter, config: settings, now: () => fixedNow,
});
const wire = status => ({ results: { todos: { status } } });
const invalidWire = { results: { todos: { status: "changes", changes: "not-an-array" } } };

async function prepare(data) {
  const [message] = await data.repositories.source.getObservedWindow();
  data.inspect.state.working.todos.push({ id: "todo:existing", text: "整理采购清单", actor: "assistant", requester: "assistant",
    dueAt: "2026-01-02T00:00:00.000Z", status: "overdue", becameOverdueAt: "2026-01-02T00:00:00.000Z",
    sourceRefs: [{ messageId: message.id, contentHash: message.contentHash }], createdAtMessageId: 1, updatedAtMessageId: 1 });
}

for (const failure of ["business", "wire_schema", "transport"]) {
  test(`${failure} repair followed by unable ends before expansion and stays ended after restart`, async () => {
    const data = store();
    await prepare(data);
    let calls = 0;
    const first = pipeline(data, adapter(async request => {
      if (++calls === 1) {
        if (failure === "transport") return { output: null, rawOutput: '{"results":', transportError: "content_incomplete_json" };
        if (failure === "wire_schema") return { output: invalidWire };
        return { output: { results: { todos: { status: "changes", changes: [{ action: "revise", target: "T1",
          text: { mode: "keep" }, actor: { mode: "keep" }, requester: { mode: "set", value: "user" },
          due: { mode: "keep" }, sources: ["message:1"] }] } } } };
      }
      assert.ok(request.repairContext, "the original retry must still receive its feedback");
      return { output: wire("unable_to_decide") };
    }));
    const getWindow = data.repositories.source.getForceDrainWindow;
    data.repositories.source.getForceDrainWindow = async () => { throw new Error("pause during expansion"); };
    await assert.rejects(first.processIntent(1, "default", intent), /pause during expansion/);
    let row = [...data.inspect.tasks.values()][0];
    assert.equal(row.stage, "context_expanding");
    assert.equal(row.stage_payload.schemaRepairFeedback, undefined, "a durable unable result ends active repair");
    const history = structuredClone(row.stage_payload.schemaRejectedOutputs);
    const counter = failure === "transport" ? "transportInvalidAttempts" : "schemaInvalidAttempts";
    assert.equal(row.stage_payload[counter], 1);
    assert.equal(data.inspect.ops[0].detail.repairFeedback.validationLayer, failure);
    assert.equal(data.inspect.state.meta.revision, 0);

    // Simulate an older process that saved unable but left its previous repair active.
    row.stage_payload.schemaRepairFeedback = structuredClone(data.inspect.ops[0].detail.repairFeedback);
    delete row.stage_payload.schemaRepairFeedback.inputVariant;
    data.repositories.source.getForceDrainWindow = getWindow;
    let resumedCalls = 0;
    const resumed = pipeline(data, adapter(async request => {
      resumedCalls++;
      assert.equal(request.repairContext, null);
      assert.equal(request.systemPrompt, "todo prompt");
      return { output: wire("noop") };
    }));
    assert.equal((await resumed.processEnvelope(row.task_payload)).status, "context_expansion_required");
    row = JSON.parse(JSON.stringify(data.inspect.tasks.get(row.task_id)));
    data.inspect.tasks.set(row.task_id, row);
    assert.equal(row.stage_payload.schemaRepairFeedback, undefined);
    assert.equal(row.stage_payload[counter], 1);
    assert.deepEqual(row.stage_payload.schemaRejectedOutputs, history);
    assert.equal((await resumed.processEnvelope(row.task_payload)).status, "committed");
    assert.equal(resumedCalls, 1);
    assert.equal(row.attempt, 2, "ending repair must not reset or consume retry allowance");
    assert.equal(row.stage_payload[counter], 1);
  });
}

test("expanded-input repair survives another restart without replaying the base candidate or resetting its budget", async () => {
  const data = store();
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, schemaInvalidRetryMax: 2 } };
  let calls = 0;
  const first = pipeline(data, adapter(async () => ({ output: ++calls === 1 ? invalidWire : wire("unable_to_decide") })), settings);
  assert.equal((await first.processIntent(1, "default", intent)).status, "context_expansion_required");
  let row = [...data.inspect.tasks.values()][0];
  // This is the legacy context_expanded shape, before the lifecycle fix.
  row.stage_payload.schemaRepairFeedback = structuredClone(data.inspect.ops[0].detail.repairFeedback);
  delete row.stage_payload.schemaRepairFeedback.inputVariant;
  const expandedInvalid = { results: { todos: { status: "changes", changes: [{ action: "add", text: "expanded candidate" }] } } };
  const freshAdapter = adapter(async request => {
    assert.equal(request.repairContext, null, "unbound legacy feedback must not enter the expanded request");
    return { output: expandedInvalid };
  });
  let attempts = 0;
  const second = pipeline(data, { propose: (...args) => ++attempts === 1 ? freshAdapter.propose(...args)
    : { status: "deferred", reason: "pause after expanded repair persistence" } }, settings);
  assert.equal((await second.processEnvelope(row.task_payload)).status, "queued");
  row = JSON.parse(JSON.stringify(row));
  data.inspect.tasks.set(row.task_id, row);
  assert.equal(row.stage_payload.schemaRepairFeedback.inputVariant, "expanded");
  assert.equal(row.stage_payload.schemaInvalidAttempts, 2);
  assert.deepEqual(row.stage_payload.schemaRejectedOutputs.map(entry => entry.output), [invalidWire, expandedInvalid]);
  let resumedCalls = 0;
  let resumedRequest;
  const third = pipeline(data, adapter(async request => {
    resumedCalls++;
    resumedRequest = request;
    return { output: invalidWire }; // All schema allowance was already consumed.
  }), settings);
  const result = await third.processEnvelope(row.task_payload);
  assert.equal(result.halted, true);
  assert.equal(result.reason, "output_schema_invalid");
  assert.deepEqual(resumedRequest.repairContext.assistantOutput, expandedInvalid);
  assert.equal(resumedCalls, 1);
  assert.equal(row.stage_payload.schemaInvalidAttempts, 2);
  assert.equal(data.inspect.state.meta.revision, 0);
});
