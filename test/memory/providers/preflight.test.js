const test = require("node:test");
const assert = require("node:assert/strict");
const { runStructuredOutputPreflight } = require("../../../modules/memory/infrastructure/providers/providerPreflight");

test("provider preflight exercises every normal proposer and compaction schema", async () => {
  const requests = [];
  const results = await runStructuredOutputPreflight({
    promptLoader: async (proposer) => `prompt:${proposer}`,
    invokeStructured: async (request) => {
      requests.push(request);
      return { output: structuredClone(request.userPayload.expectedOutput), finishReason: "tool_calls" };
    },
  });
  assert.deepEqual(results.map((entry) => entry.name), [
    "scene", "todos", "standingAgreements", "episodes", "profileRelationship", "worldFacts", "compaction:todos",
  ]);
  assert.equal(new Set(requests.map((request) => request.responseSchema.name)).size, 7);
  assert.equal(requests.every((request) => request.responseSchema.strict === true), true);
  assert.equal(requests.every((request) => request.systemPrompt.startsWith(`prompt:${request.proposer}`)), true);
});

test("provider preflight rejects a schema-valid but wrong result branch", async () => {
  await assert.rejects(() => runStructuredOutputPreflight({
    promptLoader: async () => "prompt",
    invokeStructured: async (request) => ({
      output: { ...request.userPayload.expectedOutput, sectionResults: Object.fromEntries(Object.keys(request.userPayload.expectedOutput.sectionResults).map((section) => [section, { status: "unable_to_decide" }])) },
    }),
  }), /exact preflight branch/);
});
