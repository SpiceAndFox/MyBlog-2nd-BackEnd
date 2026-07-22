const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProposerUserPayload,
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
} = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { envelope, profileEnvelope } = require("../support/provider-envelopes");

test("Provider Adapter accepts valid native structured output", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: { tickId: 7, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" }, milestones: { status: "noop" } } } };
    },
  });
  const result = await adapter.propose(envelope());
  assert.equal(result.status, "ok");
  assert.equal(request.responseSchema.strict, true);
});

test("Provider Adapter evaluates Profile sections independently and merges one atomic result", async () => {
  const requests = [];
  const sections = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "base profile prompt",
    invokeStructured: async (request) => {
      requests.push(request);
      const section = sections[request.proposer];
      return {
        output: {
          tickId: 9,
          proposer: request.proposer,
          sectionResults: { [section]: { status: "changes", changes: [{ action: "add", text: `${section} fact`, evidenceMessageIds: [1] }] } },
        },
        usage: { input_tokens: 10, output_tokens: 2 }, model: "test-model",
      };
    },
  });
  const result = await adapter.propose(profileEnvelope({ messageCount: 64 }));
  assert.equal(result.status, "ok");
  assert.equal(result.callCount, 3);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 6 });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.proposer), Object.keys(sections));
  assert.deepEqual(Object.keys(result.output.sectionResults), ["userProfile", "assistantProfile", "relationship"]);
  for (const request of requests) {
    const section = sections[request.proposer];
    assert.equal(request.userPayload.messages.length, 64);
    assert.deepEqual(request.userPayload.task.targetSections, [section]);
    assert.deepEqual(request.responseSchema.schema.properties.sectionResults.required, [section]);
    assert.equal(result.output.sectionResults[section].changes[0].text, `${section} fact`);
  }
});

test("Profile specialist schemas bind writable refs and evidence ids to the rendered namespace", async () => {
  const state = createInitialMemoryState();
  state.longTerm.userProfile.push({ id: "profile:1", text: "旧 User 档案", sourceRefs: [], createdAtMessageId: 1, updatedAtMessageId: 1 });
  state.longTerm.relationship.push({ id: "relationship:1", text: "旧关系", sourceRefs: [], createdAtMessageId: 1, updatedAtMessageId: 1 });
  const requests = [];
  const sections = { userProfileProposer: "userProfile", assistantProfileProposer: "assistantProfile", relationshipProposer: "relationship" };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async (request) => {
      requests.push(request);
      const section = sections[request.proposer];
      return { output: { tickId: 9, proposer: request.proposer, sectionResults: { [section]: { status: "noop" } } } };
    },
  });
  assert.equal((await adapter.propose(profileEnvelope({ state }))).status, "ok");
  const variantsFor = (proposer) => requests.find((request) => request.proposer === proposer)
    .responseSchema.schema.properties.sectionResults.properties[sections[proposer]].oneOf[0].properties.changes.items.oneOf;
  assert.deepEqual(variantsFor("userProfileProposer").filter((variant) => variant.properties.ref).map((variant) => variant.properties.ref.enum), [["UP1"], ["UP1"], ["UP1"]]);
  assert.deepEqual(variantsFor("relationshipProposer").filter((variant) => variant.properties.ref).map((variant) => variant.properties.ref.enum), [["R1"], ["R1"], ["R1"]]);
  assert.deepEqual(variantsFor("assistantProfileProposer").map((variant) => variant.properties.action.const), ["add"]);
  assert.deepEqual(variantsFor("userProfileProposer")[0].properties.evidenceMessageIds.items.enum, [1]);
  assert.equal(Object.hasOwn(variantsFor("userProfileProposer")[0].properties, "supportRefs"), false);
});

test("Provider Adapter distinguishes truncation, refusal, call and schema errors", async () => {
  const cases = [
    [{ finishReason: "length" }, "max_output_truncated"],
    [{ finishReason: "max_output_length" }, "max_output_truncated"],
    [{ finishReason: "content_filter" }, "safety_policy_blocked"],
    [{ refusal: true }, "safety_policy_blocked"],
    [{ output: { tickId: 7 } }, "output_schema_invalid"],
  ];
  for (const [response, reason] of cases) {
    const adapter = createMemoryProviderAdapter({ promptLoader: async () => "prompt", invokeStructured: async () => response });
    assert.equal((await adapter.propose(envelope())).reason, reason);
  }
  const adapter = createMemoryProviderAdapter({ promptLoader: async () => "prompt", invokeStructured: async () => { throw new Error("offline"); } });
  assert.equal((await adapter.propose(envelope())).reason, "llm_call_failed");
});

test("mock Adapter preserves explicit error fixtures", async () => {
  const adapter = createMockMemoryProviderAdapter({ outputs: [{ status: "error", reason: "safety_policy_blocked" }] });
  assert.deepEqual(await adapter.propose(envelope()), { status: "error", reason: "safety_policy_blocked" });
});

test("Provider Adapter preserves token usage for unsuccessful structured responses", async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async () => ({ finishReason: "length", model: "deepseek-v4-flash", usage }),
  });
  const result = await adapter.propose(envelope());
  assert.equal(result.reason, "max_output_truncated");
  assert.equal(result.model, "deepseek-v4-flash");
  assert.deepEqual(result.usage, usage);
});

test("Provider Adapter appends bounded schema repair feedback without replaying invalid output", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "base prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: { tickId: 7, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" }, milestones: { status: "noop" } } } };
    },
  });
  const result = await adapter.propose(envelope(), {
    repairFeedback: { attempt: 1, errors: [{ path: "$.sectionResults.todos.changes[0].dueAt", message: "days must be non-negative" }] },
  });
  assert.equal(result.status, "ok");
  assert.match(request.systemPrompt, /\[SCHEMA_REPAIR\]/);
  assert.match(request.systemPrompt, /dueAt.*days must be non-negative/s);
  assert.doesNotMatch(request.systemPrompt, /rawInvalidOutput/);
  assert.deepEqual(request.userPayload, buildProposerUserPayload(envelope()));
  assert.equal(Object.prototype.hasOwnProperty.call(request.userPayload.task, "taskId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.userPayload.task, "now"), false);
  assert.equal(request.userPayload.task.userTimeZone, "UTC");
  assert.equal(request.userPayload.messages[0].createdAt, "2026-07-12T00:00:00.000Z");
});

test("schema repair adds dynamic ref-namespace guidance only for ref resolution errors", () => {
  const { schemaRepairPrompt } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
  const repaired = schemaRepairPrompt("base", {
    errors: [{ path: "$.changes[0].supportRefs", message: "ref S-LOCATION was not rendered as read-only Memory" }],
  });
  assert.match(repaired, /REF_NAMESPACE_REPAIR/);
  assert.match(repaired, /不要把可修改 ref 移到 supportRefs/);
  assert.match(repaired, /evidenceMessageId.*合法辅助 ref/s);
  const copiedLine = schemaRepairPrompt("base", {
    errors: [{ path: "$.changes[0].supportRefs", message: "ref S-TIME | time: 2026-01-16 was not rendered as read-only Memory" }],
  });
  assert.match(copiedLine, /Memory 整行误当引用/);
  assert.match(copiedLine, /竖线及其右侧文本绝不是 ref/);
  assert.match(copiedLine, /S-TIME/);
  const ordinary = schemaRepairPrompt("base", { errors: [{ path: "$.tickId", message: "must match" }] });
  assert.doesNotMatch(ordinary, /REF_NAMESPACE_REPAIR/);
});
