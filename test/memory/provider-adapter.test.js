const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryProviderAdapter, createMockMemoryProviderAdapter } = require("../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { envelope } = require("./support/provider-envelopes");

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

test("Provider Adapter preserves billed usage for unsuccessful structured responses", async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.001 };
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async () => ({ finishReason: "length", model: "deepseek-v4-flash", usage }),
  });
  const result = await adapter.propose(envelope());
  assert.equal(result.reason, "max_output_truncated");
  assert.equal(result.model, "deepseek-v4-flash");
  assert.deepEqual(result.usage, usage);
});
