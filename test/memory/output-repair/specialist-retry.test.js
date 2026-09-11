const test = require("node:test");
const assert = require("node:assert/strict");
const { createRepairFeedback } = require("../../../modules/memory/application/outputRepair");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { profileEnvelope } = require("../support/provider-envelopes");
const { providerBusinessRejection } = require("../../../modules/memory/infrastructure/providers/providerBusinessRejection");

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
        ? "关".repeat(request.userPayload.task.writeLimits.relationship.maxItemChars + 1)
        : `${section} fact`;
      return {
        output: {
          sectionStatuses: { [section]: "changes" },
          changes: [{ section, action: "add", text, sources: ["message:1"] }],
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
  assert.equal(calls[3].systemPrompt, "prompt:relationshipProposer");
  assert.match(calls[3].repairContext.userMessage, new RegExp(`Unicode 字符数不得超过 ${envelope.task.writeLimits.relationship.maxItemChars}`));
  assert.equal(
    calls[3].responseSchema.schema.properties.changes.items.properties.section.enum[0],
    "relationship",
  );
  assert.deepEqual(
    calls[3].responseSchema.schema.properties.sectionStatuses.required,
    ["relationship"],
  );
  assert.doesNotMatch(calls[3].repairContext.userMessage, /"userProfile"|"assistantProfile"/);
});

test("Profile interrupted JSON repair tells only the failed specialist to shorten sources", async () => {
  const calls = [];
  const sections = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  let relationshipCalls = 0;
  const truncated = '{"sectionStatuses":{"relationship":"changes"},"changes":[{"section":"relationship","action":"update","text":"多次"社死"，用户还';
  const adapter = createMemoryProviderAdapter({
    promptLoader: async (proposer) => `prompt:${proposer}`,
    invokeStructured: async (request) => {
      calls.push(request);
      const section = sections[request.proposer];
      if (request.proposer === "relationshipProposer") {
        relationshipCalls += 1;
        if (relationshipCalls === 1) {
          return {
            output: null,
            rawOutput: truncated,
            transportError: "content_incomplete_json",
            finishReason: "abort",
          };
        }
      }
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
      };
    },
  });
  const envelope = profileEnvelope();

  const first = await adapter.propose(envelope);
  assert.equal(first.reason, "output_schema_invalid");
  assert.equal(first.detail.specialist, "relationshipProposer");
  assert.equal(first.detail.transportError, "content_incomplete_json");
  assert.equal(first.rejectedOutput.specialistOutputs.relationshipProposer.output, truncated);
  assert.equal(first.rejectedOutputKind, "specialist_bundle");

  const feedback = createRepairFeedback(first.detail, 1, envelope.task);
  const second = await adapter.propose(envelope, {
    repairFeedback: feedback,
    rejectedOutput: first.rejectedOutput,
  });

  assert.equal(second.status, "ok");
  assert.equal(second.callCount, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].proposer, "relationshipProposer");
  assert.equal(calls[3].systemPrompt, "prompt:relationshipProposer");
  assert.equal(Object.hasOwn(calls[3].repairContext, "assistantOutput"), false);
  assert.match(calls[3].repairContext.userMessage, /\[SCHEMA_REPAIR_V11\]/);
  assert.match(calls[3].repairContext.userMessage, /JSON 完成前中止/);
  assert.match(calls[3].repairContext.userMessage, /sources 仅保留.*最少来源/);
  assert.match(calls[3].repairContext.userMessage, /section 才使用 noop/);
  assert.match(calls[3].repairContext.userMessage, /不得从末尾继续/);
  assert.ok(calls[3].repairContext.userMessage.includes(JSON.stringify(truncated)));
});

test("Profile business recovery revalidates retained selectors and does not reuse an invalid saved section", async () => {
  const envelope = profileEnvelope();
  const wire = section => ({ sectionStatuses: { [section]: "changes" }, changes: [
    { section, action: "add", text: `${section} fact`, sources: ["message:1"] },
  ] });
  const makeAdapter = invokeStructured => createMemoryProviderAdapter({ promptLoader: async () => "prompt", invokeStructured });
  const first = await makeAdapter(async request => ({ output: wire(request.userPayload.task.targetSections[0]) })).propose(envelope);
  const mapped = providerBusinessRejection(first, { errors: [{ code: "DUPLICATE_ITEM",
    path: "$.sectionResults.relationship.changes[0].text", meta: { section: "relationship" } }] }, envelope.task);
  mapped.rejectedOutput.specialistOutputs.userProfileProposer.output.changes[0].sources = ["message:999"];
  const calls = [];
  const result = await makeAdapter(async request => {
    calls.push(request);
    const section = request.userPayload.task.targetSections[0];
    if (section === "userProfile") assert.equal(request.repairContext, null);
    else {
      assert.equal(section, "relationship");
      assert.deepEqual(request.repairContext.assistantOutput, wire(section));
    }
    return { output: { sectionStatuses: { [section]: "noop" }, changes: [] } };
  }).propose(JSON.parse(JSON.stringify(envelope)), {
    repairFeedback: createRepairFeedback({ ...mapped, validationLayer: "business" }, 1, envelope.task),
    rejectedOutput: mapped.rejectedOutput,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.callCount, 2);
  assert.deepEqual(calls.map(request => request.proposer), ["userProfileProposer", "relationshipProposer"]);
  assert.equal(result.output.sectionResults.assistantProfile.status, "changes");
  assert.equal(result.output.sectionResults.userProfile.status, "noop");
});
