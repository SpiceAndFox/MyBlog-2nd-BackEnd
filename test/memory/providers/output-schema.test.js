const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/output/outputSchema");
const { compileDeepSeekSchema } = require("../../../modules/memory/infrastructure/providers/transport/deepSeekSchemaCompiler");
const { sceneEnvelope } = require("../support/provider-envelopes");

test("output schema is target-specific and requires every joint section", () => {
  const schema = buildOutputSchema("episodeProposer").schema;
  assert.deepEqual(schema.properties.sectionStatuses.required, ["recentEpisodes", "milestones"]);
  assert.equal(schema.properties.sectionStatuses.additionalProperties, false);
  assert.deepEqual(schema.properties.changes.items.properties.section.enum, ["recentEpisodes", "milestones"]);
  assert.equal(JSON.stringify(schema).includes('"oneOf"'), false);
  assert.equal(JSON.stringify(schema).includes('"anyOf"'), false);
});

test("scene Provider schema exposes flat target and sources while adapter returns Semantic output", async () => {
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
  const change = request.responseSchema.schema.properties.changes.items;
  assert.deepEqual(change.properties.action.enum, ["set", "correct", "clear", "forget"]);
  assert.deepEqual(change.properties.target.enum, ["S-LOCATION", "S-MOOD", "S-NOTE", "S-TIME"]);
  assert.deepEqual(change.properties.sources.items.enum, ["message:1"]);
  assert.deepEqual(change.required, ["section", "action", "sources"]);
  const compiled = compileDeepSeekSchema(request.responseSchema.schema);
  const serialized = JSON.stringify(compiled);
  assert.equal(serialized.includes('"evidenceRef"'), false);
  assert.equal(serialized.includes('"sourceRefs"'), false);
  assert.equal(serialized.includes('"evidenceMessageIds"'), false);
  assert.equal(serialized.includes('"supportRefs"'), false);
});

test("compaction output schema is maintenance-only and section-specific", () => {
  const schema = buildOutputSchema("compactionProposer", ["todos"]).schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["todos"]);
  const resultVariants = schema.properties.sectionResults.properties.todos.oneOf;
  const change = resultVariants[0].properties.changes.items;
  assert.equal(change.properties.action.const, "merge");
  assert.deepEqual(change.required, ["action", "refs", "text", "supportRefs"]);
  assert.equal(JSON.stringify(change).includes("itemId"), false);
  assert.equal(JSON.stringify(change).includes("evidenceKind"), false);
  assert.equal(resultVariants[1].properties.status.const, "unable_to_compact");
});

test("profile output schema exposes only text Semantic changes and source selectors", () => {
  const schema = buildOutputSchema("profileRelationshipProposer").schema;
  assert.deepEqual(schema.properties.sectionStatuses.required, ["userProfile", "assistantProfile", "relationship"]);
  const change = schema.properties.changes.items;
  assert.deepEqual(change.required, ["section", "action", "sources"]);
  assert.deepEqual(change.properties.action.enum, ["add", "revise", "correct", "forget"]);
  assert.equal(JSON.stringify(schema).includes('"oneOf"'), false);
  assert.equal(JSON.stringify(schema).includes('"anyOf"'), false);
  for (const forbidden of ["op", "itemId", "evidenceKind", "quote", "facet", "canonicalKey", "factBasis"]) {
    assert.equal(JSON.stringify(schema).includes(`\"${forbidden}\"`), false, forbidden);
  }
});

test("profile specialist schemas each expose exactly one owned section", () => {
  const specialists = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  for (const [proposer, section] of Object.entries(specialists)) {
    const schema = buildOutputSchema(proposer).schema;
    assert.deepEqual(schema.properties.sectionStatuses.required, [section]);
    assert.deepEqual(Object.keys(schema.properties.sectionStatuses.properties), [section]);
    assert.deepEqual(schema.properties.changes.items.properties.section.enum, [section]);
  }
});

test("Librarian output schema exposes only conservative global maintenance operations", () => {
  const schema = buildOutputSchema("librarianProposer").schema;
  const changes = schema.oneOf.find((branch) => branch.properties.status.const === "changes");
  const noop = schema.oneOf.find((branch) => branch.properties.status.const === "noop");
  assert.deepEqual(changes.required, ["tickId", "proposer", "status", "operations"]);
  assert.equal(changes.properties.operations.minItems, 1);
  assert.equal(noop.properties.operations.maxItems, 0);
  const variants = changes.properties.operations.items.oneOf;
  assert.deepEqual([...new Set(variants.map((variant) => variant.properties.action.const))], [
    "move", "merge", "revise", "correct", "remove", "split",
  ]);
  const userProfileMerge = variants.find((variant) => (
    variant.properties.action.const === "merge"
    && variant.properties.toSection.const === "userProfile"
  ));
  assert.equal(userProfileMerge.properties.text.maxLength, undefined, "limits are bound from the task");
  const split = variants.find((variant) => variant.properties.action.const === "split");
  const relationshipPart = split.properties.parts.items.oneOf.find(
    (variant) => variant.properties.toSection.const === "relationship",
  );
  assert.equal(relationshipPart.properties.text.maxLength, undefined, "limits are bound from the task");
  assert.equal(JSON.stringify(schema).includes("evidenceMessageIds"), false);
  assert.equal(JSON.stringify(schema).includes("addItem"), false);
});
