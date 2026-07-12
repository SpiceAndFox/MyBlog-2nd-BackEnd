const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { buildNormalEnvelope } = require("../../modules/memory/application/envelope");
const { createMemoryProviderAdapter, createMockMemoryProviderAdapter } = require("../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { buildOutputSchema } = require("../../modules/memory/infrastructure/providers/outputSchema");

const config = { overdueTodos: { maxRenderedItems: 2 } };
function envelope() {
  return buildNormalEnvelope({
    userId: 1, presetId: "default", state: createInitialMemoryState(),
    intent: { targetKey: "episodes", proposer: "episodeProposer", targetSections: ["recentEpisodes", "milestones"], cursorBefore: 0 },
    messages: [{ id: 1, role: "user", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content: "你好", contentHash: `sha256:${"a".repeat(64)}` }],
    now: "2026-07-12T00:00:01Z", taskId: "task", tickId: 7, config,
  });
}

test("output schema is target-specific and requires every joint section", () => {
  const schema = buildOutputSchema("episodeProposer").schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["recentEpisodes", "milestones"]);
  assert.equal(schema.properties.sectionResults.additionalProperties, false);
});

test("compaction output schema is maintenance-only and section-specific", () => {
  const schema = buildOutputSchema("compactionProposer", ["todos"]).schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["todos"]);
  const resultVariants = schema.properties.sectionResults.properties.todos.oneOf;
  assert.equal(resultVariants[0].properties.patches.items.properties.op.const, "mergeItems");
  assert.equal(resultVariants[1].properties.status.const, "unable_to_compact");
});

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
