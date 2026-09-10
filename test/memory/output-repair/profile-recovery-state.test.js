const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { providerBusinessRejection } = require("../../../modules/memory/infrastructure/providers/providerBusinessRejection");
const { validateProviderWireOutput } = require("../../../modules/memory/infrastructure/providers/validateProviderWireOutput");
const { createRepairFeedback, appendRejectedOutputAttempt, latestRejectedOutput } = require("../../../modules/memory/application/outputRepair");
const { profileEnvelope } = require("../support/provider-envelopes");

const candidate = section => ({ sectionStatuses: { [section]: "changes" },
  changes: [{ section, action: "add", text: `${section} fact`, sources: ["message:1"] }] });
const adapter = invokeStructured => createMemoryProviderAdapter({ promptLoader: async proposer => `prompt:${proposer}`, invokeStructured });
// Persisted JSON objects need not retain insertion order; arrays must retain it.
const reorderedJson = value => JSON.parse(JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).reverse()) : entry));
function restore(result, envelope) {
  const feedback = createRepairFeedback(result.detail, 1, envelope.task);
  const payload = appendRejectedOutputAttempt({}, result, 0, 3);
  const saved = reorderedJson({ feedback, payload });
  return { repairFeedback: saved.feedback, rejectedOutput: latestRejectedOutput(saved.payload, saved.feedback) };
}

test("a fresh Profile adapter restores each specialist's error and valid siblings despite reordered JSON keys", async () => {
  const envelope = profileEnvelope();
  const incomplete = '{"sectionStatuses":{"userProfile":';
  let invalidRelationship;
  const first = await adapter(async request => {
    const section = request.userPayload.task.targetSections[0];
    if (section === "userProfile") return { output: null, rawOutput: incomplete,
      transportError: "content_incomplete_json", finishReason: "abort" };
    if (section === "relationship") {
      invalidRelationship = candidate(section);
      invalidRelationship.changes[0].sources = "invalid";
      return { output: invalidRelationship, outputSchemaErrors: validateProviderWireOutput(request.responseSchema, invalidRelationship).errors };
    }
    return { output: candidate(section), usage: { prompt_tokens: 100 } };
  }).propose(envelope);
  assert.equal(first.detail.specialist, "userProfileProposer");
  const options = restore(first, envelope);
  const entries = options.rejectedOutput.specialistOutputs;
  assert.equal(entries.userProfileProposer.repairFeedback.validationLayer, "transport");
  assert.equal(entries.relationshipProposer.repairFeedback.validationLayer, "wire_schema");
  assert.equal(entries.assistantProfileProposer.repairFeedback, undefined);
  const requests = [];
  const result = await adapter(async request => {
    requests.push(request);
    const section = request.userPayload.task.targetSections[0];
    if (section === "userProfile") {
      assert.ok(request.repairContext.userMessage.includes(JSON.stringify(incomplete)));
      assert.match(request.repairContext.userMessage, /更短但完整/);
    } else {
      assert.equal(section, "relationship");
      assert.deepEqual(request.repairContext.assistantOutput, invalidRelationship);
      assert.match(request.repairContext.userMessage, /\$\.changes\[0\]\.sources/);
      assert.doesNotMatch(request.repairContext.userMessage, /STRUCTURED_OUTPUT_INCOMPLETE|userProfile/);
    }
    return { output: candidate(section), usage: { prompt_tokens: 10 } };
  }).propose(reorderedJson(envelope), options);
  assert.equal(result.status, "ok");
  assert.deepEqual(requests.map(request => request.proposer), ["userProfileProposer", "relationshipProposer"]);
  assert.equal(result.callCount, 2);
  assert.equal(result.usage.prompt_tokens, 20);
  assert.deepEqual(result.specialistOutputs.assistantProfileProposer, entries.assistantProfileProposer);
  assert.ok(Object.values(result.specialistOutputs).every(entry => !entry.repairFeedback));
});

for (const change of ["input", "task"]) test(`Profile recovery does not reuse candidates after its ${change} changes`, async () => {
  const envelope = profileEnvelope();
  const first = await adapter(async request => ({ output: candidate(request.userPayload.task.targetSections[0]) })).propose(envelope);
  const mapped = providerBusinessRejection(first, { errors: [{ code: "DUPLICATE_ITEM",
    path: "$.sectionResults.relationship.changes[0].text", meta: { section: "relationship" } }] }, envelope.task);
  const options = restore({ ...mapped, detail: { validationLayer: "business", errors: mapped.errors } }, envelope);
  const changed = structuredClone(envelope);
  if (change === "input") changed.artifact.publicInput.memoryText += "\n补充上下文";
  else {
    changed.task.taskId = "00000000-0000-4000-8000-000000000099";
    changed.artifact.publicInput.task.taskId = changed.task.taskId;
  }
  const requests = [];
  const result = await adapter(async request => {
    requests.push(request);
    assert.equal(request.repairContext, null, "previous input's assistant candidate must not be replayed");
    return { output: candidate(request.userPayload.task.targetSections[0]) };
  }).propose(changed, options);
  assert.equal(result.status, "ok");
  assert.equal(requests.length, 3);
  assert.equal(result.callCount, 3);
});

test("v8 task-local business bundles without per-specialist feedback remain readable", async () => {
  const envelope = profileEnvelope();
  const first = await adapter(async request => ({ output: candidate(request.userPayload.task.targetSections[0]) })).propose(envelope);
  const mapped = providerBusinessRejection(first, { errors: [{ code: "DUPLICATE_ITEM",
    path: "$.sectionResults.relationship.changes[0].text", meta: { section: "relationship" } }] }, envelope.task);
  const options = restore({ ...mapped, detail: { validationLayer: "business", errors: mapped.errors } }, envelope);
  delete options.rejectedOutput.inputHash;
  for (const entry of Object.values(options.rejectedOutput.specialistOutputs)) delete entry.repairFeedback;
  const requests = [];
  const result = await adapter(async request => {
    requests.push(request);
    assert.deepEqual(request.repairContext.assistantOutput, candidate("relationship"));
    return { output: { sectionStatuses: { relationship: "noop" }, changes: [] } };
  }).propose(JSON.parse(JSON.stringify(envelope)), options);
  assert.equal(result.status, "ok");
  assert.deepEqual(requests.map(request => request.proposer), ["relationshipProposer"]);
});
