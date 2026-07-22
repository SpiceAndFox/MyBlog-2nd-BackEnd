const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryProviderAdapter } = require("../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { buildOutputSchema } = require("../../modules/memory/infrastructure/providers/outputSchema");
const { compileDeepSeekSchema } = require("../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler");
const { sceneEnvelope } = require("./support/provider-envelopes");

test("output schema is target-specific and requires every joint section", () => {
  const schema = buildOutputSchema("episodeProposer").schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["recentEpisodes", "milestones"]);
  assert.equal(schema.properties.sectionResults.additionalProperties, false);
});

test("scene Provider schema exposes Semantic refs and no persistence provenance", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: {
        tickId: 8,
        proposer: "currentStateProposer",
        sectionResults: { scene: { status: "changes", changes: [{
          action: "set",
          ref: "S-LOCATION",
          text: "屋顶",
          evidenceMessageIds: [1],
        }] } },
      } };
    },
  });
  const result = await adapter.propose(sceneEnvelope());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output.sectionResults.scene.changes[0].evidenceMessageIds, [1]);
  const changeVariants = request.responseSchema.schema.properties.sectionResults.properties.scene.oneOf[0].properties.changes.items.oneOf;
  assert.equal(changeVariants.some((variant) => variant.properties.action.const === "set"), true);
  assert.equal(changeVariants.every((variant) => !variant.required.includes("sourceRefs")), true);
  const compiled = compileDeepSeekSchema(request.responseSchema.schema);
  const serialized = JSON.stringify(compiled);
  assert.equal(serialized.includes('"evidenceRef"'), false);
  assert.equal(serialized.includes('"sourceRefs"'), false);
});

test("compaction output schema is maintenance-only and section-specific", () => {
  const schema = buildOutputSchema("compactionProposer", ["todos"]).schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["todos"]);
  const resultVariants = schema.properties.sectionResults.properties.todos.oneOf;
  const change = resultVariants[0].properties.changes.items;
  assert.equal(change.properties.action.const, "merge");
  assert.deepEqual(change.required, ["action", "refs", "text"]);
  assert.equal(JSON.stringify(change).includes("itemId"), false);
  assert.equal(JSON.stringify(change).includes("evidenceKind"), false);
  assert.equal(resultVariants[1].properties.status.const, "unable_to_compact");
});

test("profile output schema exposes only text Semantic changes and source selectors", () => {
  const schema = buildOutputSchema("profileRelationshipProposer").schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["userProfile", "assistantProfile", "relationship"]);
  const changes = schema.properties.sectionResults.properties.userProfile.oneOf[0].properties.changes.items.oneOf;
  const add = changes.find((variant) => variant.properties.action.const === "add");
  const correct = changes.find((variant) => variant.properties.action.const === "correct");
  const forget = changes.find((variant) => variant.properties.action.const === "forget");
  assert.deepEqual(add.required, ["action", "text"]);
  assert.deepEqual(correct.required, ["action", "ref", "text"]);
  assert.deepEqual(forget.required, ["action", "ref"]);
  assert.deepEqual(add.anyOf, [{ required: ["evidenceMessageIds"] }, { required: ["supportRefs"] }]);
  for (const forbidden of ["op", "itemId", "evidenceKind", "quote", "facet", "canonicalKey", "factBasis"]) {
    assert.equal(JSON.stringify(schema).includes(`\"${forbidden}\"`), false, forbidden);
  }
});
