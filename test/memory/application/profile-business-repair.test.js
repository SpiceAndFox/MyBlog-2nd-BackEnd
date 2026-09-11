const test = require("node:test");
const assert = require("node:assert/strict");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { validateProviderWireOutput } = require("../../../modules/memory/infrastructure/providers/output/validateProviderWireOutput");
const { config: baseConfig, fixedNow, store: createStore } = require("../support/recovery-harness");
const config = { ...baseConfig, targets: { ...baseConfig.targets, profileRelationship: { lagThreshold: 1, contextWindow: 2 } } };

const sections = { userProfileProposer: "userProfile", assistantProfileProposer: "assistantProfile", relationshipProposer: "relationship" };
const candidate = section => ({ sectionStatuses: { [section]: "changes" },
  changes: [{ section, action: "add", text: `${section} fact`, sources: ["message:1"] }] });

for (const affected of [["relationship"], ["userProfile", "relationship"]]) {
  test(`Profile business retry restores original specialist candidates after restart: ${affected.join(", ")}`, async () => {
    const store = createStore();
    const [message] = await store.repositories.source.getObservedWindow();
    for (const section of affected) store.inspect.state.longTerm[section].push({
      id: `existing:${section}`, text: `${section} fact`, sourceRefs: [{ messageId: 1, contentHash: message.contentHash }],
      createdAtMessageId: 1, updatedAtMessageId: 1,
    });
    const before = structuredClone(store.inspect.state);
    const firstRequests = [];
    const adapter = createMemoryProviderAdapter({ promptLoader: async proposer => proposer, invokeStructured: async request => {
      firstRequests.push(request);
      return { output: candidate(sections[request.proposer]), outputChannel: "tool_arguments", rawSchemaValid: true,
        usage: { prompt_tokens: 10, completion_tokens: 5 } };
    } });
    let calls = 0;
    const pipeline = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, now: () => fixedNow,
      providerAdapter: { propose: (...args) => ++calls === 1 ? adapter.propose(...args)
        : { status: "deferred", reason: "test_pause_after_persist" } },
    });
    const result = await pipeline.processIntent(1, "default", {
      targetKey: "profileRelationship", proposer: "profileRelationshipProposer", targetSections: Object.values(sections),
    });
    assert.equal(result.status, "queued");
    assert.equal(firstRequests.length, 3);
    assert.deepEqual(store.inspect.state, before);
    const row = [...store.inspect.tasks.values()][0];
    assert.equal(row.stage, "schema_invalid_retry");
    row.stage_payload = JSON.parse(JSON.stringify(row.stage_payload));
    const feedback = row.stage_payload.schemaRepairFeedback;
    assert.equal(feedback.validationLayer, "business");
    assert.deepEqual(feedback.errors.map(issue => issue.meta.section), affected);
    assert.ok(feedback.errors.every(issue => issue.path === "$.changes[0].text"));
    const rejected = row.stage_payload.schemaRejectedOutputs[0];
    assert.equal(rejected.outputKind, "specialist_bundle");
    for (const [proposer, section] of Object.entries(sections)) {
      assert.deepEqual(rejected.output.specialistOutputs[proposer].output, candidate(section));
      assert.equal(rejected.output.specialistOutputs[proposer].protocol.rawSchemaValid, true);
    }
    assert.doesNotMatch(JSON.stringify(store.inspect.ops), /specialistOutputs|existing:| fact/);

    // A fresh adapter has no WeakMap cache. Only persisted, bound candidates
    // can preserve successful judgments while the affected specialists retry.
    const retryRequests = [];
    const freshAdapter = createMemoryProviderAdapter({ promptLoader: async proposer => proposer, invokeStructured: async request => {
      retryRequests.push(request);
      const section = sections[request.proposer];
      assert.ok(affected.includes(section));
      assert.deepEqual(request.repairContext.assistantOutput, candidate(section));
      assert.match(request.repairContext.userMessage, /\$\.changes\[0\]\.text/);
      assert.doesNotMatch(request.repairContext.userMessage, /sectionResults|\$\.changes\[2\]/);
      assert.deepEqual(request.responseSchema.schema.properties.sectionStatuses.required, [section]);
      return { output: { sectionStatuses: { [section]: "noop" }, changes: [] },
        usage: { prompt_tokens: 20, completion_tokens: 2 } };
    } });
    let resumedProviderResult;
    const resumed = createNormalWritePipeline({ observer: {}, config, repositories: store.repositories, now: () => fixedNow,
      providerAdapter: { async propose(...args) { resumedProviderResult = await freshAdapter.propose(...args); return resumedProviderResult; } },
    });
    const committed = await resumed.processEnvelope(JSON.parse(JSON.stringify(row.task_payload)));
    assert.equal(committed.status, "committed");
    assert.equal(retryRequests.length, affected.length);
    assert.equal(resumedProviderResult.callCount, affected.length);
    assert.equal(resumedProviderResult.usage.prompt_tokens, 20 * affected.length);
    assert.equal(row.stage_payload.schemaInvalidAttempts, 1);
    assert.equal(store.inspect.state.meta.revision, 1);
    for (const section of Object.values(sections)) assert.equal(store.inspect.state.longTerm[section].length, 1);
    for (const section of affected) assert.deepEqual(store.inspect.state.longTerm[section], before.longTerm[section]);
  });
}

const failures = [
  { name: "wire schema", layer: "wire_schema", response(request) {
    const output = candidate("relationship");
    output.changes[0].sources = "not-an-array";
    return { output, outputSchemaErrors: validateProviderWireOutput(request.responseSchema, output).errors };
  } },
  { name: "semantic contract", layer: "semantic", response() {
    return { output: { ...candidate("relationship"), sectionStatuses: { relationship: "noop" } } };
  } },
  { name: "incomplete JSON", layer: "transport", response() {
    return { output: null, rawOutput: '{"sectionStatuses":{"relationship":', transportError: "content_incomplete_json", finishReason: "abort" };
  } },
  { name: "missing JSON", layer: "transport", response() {
    return { transportError: "content_missing" };
  } },
];

for (const failure of failures) test(`Profile business -> ${failure.name} -> restart preserves other specialist judgments`, async () => {
  const store = createStore();
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, schemaInvalidRetryMax: 2 } };
  const [message] = await store.repositories.source.getObservedWindow();
  store.inspect.state.longTerm.relationship.push({ id: "existing:relationship", text: "relationship fact",
    sourceRefs: [{ messageId: 1, contentHash: message.contentHash }], createdAtMessageId: 1, updatedAtMessageId: 1 });
  const before = structuredClone(store.inspect.state);
  const calls = [];
  let round = 0;
  let failedResponse;
  const adapter = createMemoryProviderAdapter({ promptLoader: async proposer => proposer, invokeStructured: async request => {
    calls.push({ round, proposer: request.proposer });
    if (round === 2) {
      assert.equal(request.proposer, "relationshipProposer");
      assert.deepEqual(request.repairContext.assistantOutput, candidate("relationship"));
      failedResponse = failure.response(request);
      return { ...failedResponse, usage: { prompt_tokens: 30, completion_tokens: 3 }, rawSchemaValid: false };
    }
    return { output: candidate(sections[request.proposer]), usage: { prompt_tokens: 10, completion_tokens: 1 } };
  } });
  const pipeline = createNormalWritePipeline({ observer: {}, config: settings, repositories: store.repositories, now: () => fixedNow,
    providerAdapter: { propose: (...args) => ++round < 3 ? adapter.propose(...args)
      : { status: "deferred", reason: "pause_before_restart" } },
  });
  assert.equal((await pipeline.processIntent(1, "default", {
    targetKey: "profileRelationship", proposer: "profileRelationshipProposer", targetSections: Object.values(sections),
  })).status, "queued");
  assert.deepEqual(calls.map(call => call.proposer), ["userProfileProposer", "assistantProfileProposer", "relationshipProposer", "relationshipProposer"]);
  const row = [...store.inspect.tasks.values()][0];
  row.stage_payload = JSON.parse(JSON.stringify(row.stage_payload));
  assert.equal(row.stage_payload.schemaRepairFeedback.validationLayer, failure.layer);
  assert.equal(row.stage_payload.schemaInvalidAttempts, failure.layer === "transport" ? 1 : 2);
  assert.equal(row.stage_payload.transportInvalidAttempts || 0, failure.layer === "transport" ? 1 : 0);
  const bundle = row.stage_payload.schemaRejectedOutputs.at(-1).output;
  assert.equal(row.stage_payload.schemaRejectedOutputs.at(-1).outputKind, "specialist_bundle");
  for (const proposer of ["userProfileProposer", "assistantProfileProposer"]) {
    assert.deepEqual(bundle.specialistOutputs[proposer].output, candidate(sections[proposer]));
    assert.equal(bundle.specialistOutputs[proposer].repairFeedback, undefined);
  }
  assert.equal(bundle.specialistOutputs.relationshipProposer.repairFeedback.validationLayer, failure.layer);
  assert.deepEqual(store.inspect.state, before);
  assert.equal(store.inspect.events.length, 0);
  assert.doesNotMatch(JSON.stringify(store.inspect.ops), /specialistOutputs|relationship fact|userProfile fact/);

  const retryRequests = [];
  const freshAdapter = createMemoryProviderAdapter({ promptLoader: async proposer => proposer, invokeStructured: async request => {
    retryRequests.push(request);
    assert.equal(request.proposer, "relationshipProposer");
    if (failure.name === "incomplete JSON") {
      assert.equal(Object.hasOwn(request.repairContext, "assistantOutput"), false);
      assert.ok(request.repairContext.userMessage.includes(JSON.stringify(failedResponse.rawOutput)));
      assert.match(request.repairContext.userMessage, /更短但完整/);
    } else if (failure.name === "missing JSON") {
      assert.equal(request.repairContext, null);
      assert.match(request.systemPrompt, /不得省略 tool call/);
    } else assert.deepEqual(request.repairContext.assistantOutput, failedResponse.output);
    assert.doesNotMatch(request.repairContext?.userMessage || request.systemPrompt, /DUPLICATE_ITEM|userProfile fact|assistantProfile fact|specialistOutputs/);
    return { output: { sectionStatuses: { relationship: "noop" }, changes: [] }, usage: { prompt_tokens: 20, completion_tokens: 2 } };
  } });
  let providerResult;
  const resumed = createNormalWritePipeline({ observer: {}, config: settings, repositories: store.repositories, now: () => fixedNow,
    providerAdapter: { async propose(...args) { providerResult = await freshAdapter.propose(...args); return providerResult; } },
  });
  assert.equal((await resumed.processEnvelope(JSON.parse(JSON.stringify(row.task_payload)))).status, "committed");
  assert.equal(retryRequests.length, 1);
  assert.equal(providerResult.callCount, 1);
  assert.deepEqual(providerResult.usage, { prompt_tokens: 20, completion_tokens: 2 });
  for (const section of Object.values(sections)) assert.equal(store.inspect.state.longTerm[section].length, 1);
  assert.deepEqual(store.inspect.state.longTerm.relationship, before.longTerm.relationship);
});
