const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProposerUserPayload,
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
} = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { buildLibrarianEnvelope } = require("../../../modules/memory/application/librarianRenderer");
const { envelope, profileEnvelope } = require("../support/provider-envelopes");

test("Provider Adapter accepts valid native structured output", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: {
        sectionStatuses: { recentEpisodes: "noop", milestones: "noop" },
        changes: [],
      } };
    },
  });
  const result = await adapter.propose(envelope());
  assert.equal(result.status, "ok");
  assert.equal(request.responseSchema.strict, true);
});

test("JSON object transport validates the parsed output locally", async () => {
  let httpRequest;
  const invokeStructured = createStructuredTransport({
    adapter: "opencode-go-json-object",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "mimo-v2.5-pro",
    reasoningEffort: "low",
    timeoutMs: 1000,
    maxInputTokens: 250_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async (_url, options) => {
      httpRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: '{"unexpected":true}' } }],
        }),
      };
    },
  });
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured,
  });

  const result = await adapter.propose(envelope());
  assert.equal(result.reason, "output_schema_invalid");
  assert.equal(result.detail.boundary, "output");
  assert.deepEqual(httpRequest.response_format, { type: "json_object" });
  assert.match(httpRequest.messages[0].content, /\[JSON_OBJECT_CONTRACT\]/);
});

test("JSON object transport rejects malformed flat wire entries before Semantic conversion", async () => {
  const invokeStructured = createStructuredTransport({
    adapter: "opencode-go-json-object",
    baseUrl: "https://opencode.test/v1/",
    apiKey: "test-key",
    model: "mimo-v2.5-pro",
    reasoningEffort: "low",
    timeoutMs: 1000,
    maxInputTokens: 250_000,
    maxOutputTokens: 1024,
  }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              sectionStatuses: {
                recentEpisodes: "noop",
                milestones: "noop",
              },
              changes: [null],
            }),
          },
        }],
      }),
    }),
  });
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured,
  });

  const result = await adapter.propose(envelope());
  assert.equal(result.reason, "output_schema_invalid");
  assert.equal(result.detail.boundary, "output");
  assert.deepEqual(result.detail.errors, [{
    path: "$.changes[0]",
    message: "must be object; received null",
  }]);
  assert.deepEqual(JSON.parse(result.rejectedOutput), {
    sectionStatuses: {
      recentEpisodes: "noop",
      milestones: "noop",
    },
    changes: [null],
  });
});

test("Provider Adapter evaluates Profile sections independently and merges one atomic result", async () => {
  const requests = [];
  let active = 0;
  let maxActive = 0;
  const sections = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "base profile prompt",
    invokeStructured: async (request) => {
      requests.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const section = sections[request.proposer];
      return {
        output: {
          sectionStatuses: { [section]: "changes" },
          changes: [{
            section,
            action: "add",
            text: `${section} fact`,
            sources: ["message:1"],
          }],
        },
        usage: { input_tokens: 10, output_tokens: 2 }, model: "test-model",
      };
    },
  });
  const result = await adapter.propose(profileEnvelope({ messageCount: 64 }));
  assert.equal(result.status, "ok");
  assert.equal(result.callCount, 3);
  assert.equal(maxActive, 3);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 6 });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.proposer), Object.keys(sections));
  assert.deepEqual(Object.keys(result.output.sectionResults), ["userProfile", "assistantProfile", "relationship"]);
  assert.ok(requests.every((request) => request.userPayload.memoryText === requests[0].userPayload.memoryText));
  assert.ok(requests.every((request) => (
    JSON.stringify(request.userPayload.messages) === JSON.stringify(requests[0].userPayload.messages)
  )));
  for (const request of requests) {
    const section = sections[request.proposer];
    assert.equal(request.userPayload.messages.length, 64);
    assert.deepEqual(request.userPayload.task.targetSections, [section]);
    assert.deepEqual(request.responseSchema.schema.properties.sectionStatuses.required, [section]);
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
      return { output: { sectionStatuses: { [section]: "noop" }, changes: [] } };
    },
  });
  assert.equal((await adapter.propose(profileEnvelope({ state }))).status, "ok");
  const propertiesFor = (proposer) => requests.find((request) => request.proposer === proposer)
    .responseSchema.schema.properties.changes.items.properties;
  assert.deepEqual(propertiesFor("userProfileProposer").target.enum, ["UP1"]);
  assert.deepEqual(propertiesFor("relationshipProposer").target.enum, ["R1"]);
  assert.equal(Object.hasOwn(propertiesFor("assistantProfileProposer"), "target"), false);
  assert.deepEqual(propertiesFor("assistantProfileProposer").action.enum, ["add"]);
  assert.deepEqual(propertiesFor("userProfileProposer").sources.items.enum, ["message:1"]);
  assert.equal(Object.hasOwn(propertiesFor("userProfileProposer"), "supportRefs"), false);
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

test("Provider Adapter replays rejected output and feedback as a multi-turn repair request", async () => {
  let request;
  const rejectedOutput = {
    sectionStatuses: { recentEpisodes: "noop", milestones: "noop" },
    changes: [{ section: "recentEpisodes", action: "add", sources: [] }],
  };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "base prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: { tickId: 7, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" }, milestones: { status: "noop" } } } };
    },
  });
  const result = await adapter.propose(envelope(), {
    repairFeedback: { attempt: 1, errors: [{ path: "$.sectionResults.todos.changes[0].dueAt", message: "days must be non-negative" }] },
    rejectedOutput,
  });
  assert.equal(result.status, "ok");
  assert.equal(request.systemPrompt, "base prompt");
  assert.doesNotMatch(request.systemPrompt, /SCHEMA_REPAIR/);
  assert.deepEqual(request.repairContext.assistantOutput, rejectedOutput);
  assert.match(request.repairContext.userMessage, /\[SCHEMA_REPAIR_V6\]/);
  assert.match(request.repairContext.userMessage, /dueAt.*days must be non-negative/s);
  assert.deepEqual(request.userPayload, buildProposerUserPayload(envelope()));
  assert.equal(Object.prototype.hasOwnProperty.call(request.userPayload.task, "taskId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.userPayload.task, "now"), false);
  assert.equal(request.userPayload.task.userTimeZone, "UTC");
  assert.equal(request.userPayload.messages[0].createdAt, "2026-07-12T00:00:00.000Z");
});

test("Provider Adapter keeps the legacy combined-prompt fallback for old repair tasks", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "base prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: { tickId: 7, proposer: "episodeProposer", sectionResults: { recentEpisodes: { status: "noop" }, milestones: { status: "noop" } } } };
    },
  });
  await adapter.propose(envelope(), {
    repairFeedback: { attempt: 1, errors: [{ path: "$", message: "invalid" }] },
  });
  assert.match(request.systemPrompt, /\[SCHEMA_REPAIR_V6\]/);
  assert.equal(request.repairContext, null);
});

test("schema repair adds concise positive enum guidance only for selector errors", () => {
  const { schemaRepairPrompt } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
  const repaired = schemaRepairPrompt("base", {
    errors: [{ path: "$.changes[0].supportRefs", message: "ref S-LOCATION was not rendered as read-only Memory" }],
  });
  assert.match(repaired, /SELECT_ONLY_SCHEMA_ENUM_SOURCES|tool schema 的 enum/);
  assert.match(repaired, /\[SUPPORT_REF_INVALID\]/);
  assert.doesNotMatch(repaired, /误当|竖线/);
  assert.doesNotMatch(repaired, /S-LOCATION/);
  const ordinary = schemaRepairPrompt("base", { errors: [{ path: "$.tickId", message: "must match" }] });
  assert.doesNotMatch(ordinary, /tool schema 的 enum/);
});

test("Provider Adapter accepts the Librarian message-free global maintenance contract", async () => {
  const librarianEnvelope = buildLibrarianEnvelope({
    userId: 1,
    presetId: "default",
    state: createInitialMemoryState(),
    boundaryMessageId: 0,
    watermarkOrdinal: 0,
    triggerType: "manual",
    now: "2026-07-26T00:00:00.000Z",
    userTimeZone: "Asia/Shanghai",
    taskId: "librarian-task",
    tickId: 99,
  });
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "librarian prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: { tickId: 99, proposer: "librarianProposer", status: "noop", operations: [] } };
    },
  });
  const result = await adapter.propose(librarianEnvelope);
  assert.equal(result.status, "ok");
  assert.deepEqual(request.userPayload.messages, []);
  assert.equal(request.userPayload.task.cursorBefore, undefined);
  assert.equal(request.responseSchema.name, "memory_librarian_semantic");
  assert.equal(request.responseSchema.schema.oneOf.length, 1);
  assert.deepEqual(request.responseSchema.schema.oneOf[0].properties.status, { const: "noop" });
  assert.equal(request.responseSchema.schema.oneOf[0].properties.operations.maxItems, 0);
});
