const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProposerUserPayload,
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
} = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { envelope } = require("../support/provider-envelopes");

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
