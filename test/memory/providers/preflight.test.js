const test = require("node:test");
const assert = require("node:assert/strict");
const { runStructuredOutputPreflight } = require("../../../modules/memory/infrastructure/providers/diagnostics/providerPreflight");
const { loadProposerPrompt } = require("../../../modules/memory/prompts");

test("provider preflight exercises every normal proposer and both maintenance schemas", async () => {
  const requests = [];
  const results = await runStructuredOutputPreflight({
    promptLoader: async (proposer) => `prompt:${proposer}`,
    invokeStructured: async (request) => {
      requests.push(request);
      return { output: structuredClone(request.userPayload.expectedOutput), finishReason: "tool_calls" };
    },
  });
  assert.deepEqual(results.map((entry) => entry.name), [
    "scene", "todos", "standingAgreements", "episodes",
    "profileRelationship:userProfile", "profileRelationship:assistantProfile", "profileRelationship:relationship",
    "worldFacts", "compaction:todos", "librarian",
    "todos:add-relative", "todos:revise-keep", "todos:complete",
  ]);
  assert.equal(new Set(requests.map((request) => request.responseSchema.name)).size, 10);
  assert.equal(requests.every((request) => request.responseSchema.strict === true), true);
  assert.equal(requests.every((request) => request.systemPrompt.startsWith(`prompt:${request.proposer}`)), true);
  assert.equal(results.every((entry) => entry.proposer), true);
  assert.equal(results.every((entry) => entry.model === null), true);
});

test("Todo-only preflight exercises the official prompt and all four contract branches", async () => {
  const prompt = await loadProposerPrompt("todoProposer");
  const results = await runStructuredOutputPreflight({
    todoOnly: true,
    promptLoader: loadProposerPrompt,
    invokeStructured: async (request) => {
      assert.equal(request.proposer, "todoProposer");
      assert.ok(request.systemPrompt.startsWith(`${prompt}\n\n[PREFLIGHT]`));
      assert.equal(request.responseSchema.name, "memory_todo");
      return { output: request.userPayload.expectedOutput };
    },
  });
  assert.deepEqual(results.map(entry => entry.name), ["todos:noop", "todos:add-relative", "todos:revise-keep", "todos:complete"]);
});

test("provider preflight rejects a schema-valid but wrong result branch", async () => {
  await assert.rejects(() => runStructuredOutputPreflight({
    promptLoader: async () => "prompt",
    invokeStructured: async (request) => ({
      output: request.userPayload.expectedOutput.sectionStatuses
        ? {
          ...request.userPayload.expectedOutput,
          sectionStatuses: Object.fromEntries(
            Object.keys(request.userPayload.expectedOutput.sectionStatuses)
              .map((section) => [section, "unable_to_decide"]),
          ),
        }
        : request.userPayload.expectedOutput,
    }),
  }), /exact preflight branch/);
});
