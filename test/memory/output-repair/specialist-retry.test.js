const test = require("node:test");
const assert = require("node:assert/strict");
const { PROFILE_TEXT_MAX_CHARS } = require("../../../modules/memory/contracts/constants");
const { createRepairFeedback } = require("../../../modules/memory/application/outputRepair");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { profileEnvelope } = require("../support/provider-envelopes");

test("Profile repair retries only the failed specialist and merges cached valid sections", async () => {
  const calls = [];
  const sections = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  let relationshipCalls = 0;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async (proposer) => `prompt:${proposer}`,
    invokeStructured: async (request) => {
      calls.push(request);
      const section = sections[request.proposer];
      if (request.proposer === "relationshipProposer") relationshipCalls += 1;
      const text = request.proposer === "relationshipProposer" && relationshipCalls === 1
        ? "关".repeat(PROFILE_TEXT_MAX_CHARS.relationship + 1)
        : `${section} fact`;
      return {
        output: {
          tickId: 9,
          proposer: request.proposer,
          sectionResults: {
            [section]: {
              status: "changes",
              changes: [{ action: "add", text, evidenceMessageIds: [1] }],
            },
          },
        },
      };
    },
  });
  const envelope = profileEnvelope();

  const first = await adapter.propose(envelope);
  assert.equal(first.reason, "output_schema_invalid");
  assert.equal(first.detail.specialist, "relationshipProposer");
  assert.equal(calls.length, 3);

  const feedback = createRepairFeedback(first.detail, 1, envelope.task);
  const second = await adapter.propose(envelope, { repairFeedback: feedback });
  assert.equal(second.status, "ok");
  assert.equal(second.callCount, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].proposer, "relationshipProposer");
  assert.deepEqual(Object.keys(second.output.sectionResults), [
    "userProfile",
    "assistantProfile",
    "relationship",
  ]);
  assert.match(calls[3].systemPrompt, new RegExp(`Unicode 字符数不得超过 ${PROFILE_TEXT_MAX_CHARS.relationship}`));
  assert.equal(
    calls[3].responseSchema.schema.properties.proposer.const,
    "relationshipProposer",
  );
  assert.deepEqual(
    calls[3].responseSchema.schema.properties.sectionResults.required,
    ["relationship"],
  );
  assert.doesNotMatch(calls[3].systemPrompt, /"userProfile"|"assistantProfile"/);
});
