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

test("scene Provider schema uses one evidenceRef object and adapter normalizes it to canonical evidenceRefs", async () => {
  let request;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "prompt",
    invokeStructured: async (value) => {
      request = value;
      return { output: {
        tickId: 8,
        proposer: "currentStateProposer",
        sectionResults: { scene: { status: "patches", patches: [{
          op: "setField",
          path: "location",
          value: "屋顶",
          evidenceKind: "scene_change",
          evidenceRef: { messageId: 1, quote: "来到屋顶" },
        }] } },
      } };
    },
  });
  const result = await adapter.propose(sceneEnvelope());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output.sectionResults.scene.patches[0].evidenceRefs, [{ messageId: 1, quote: "来到屋顶" }]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.output.sectionResults.scene.patches[0], "evidenceRef"), false);
  const patchVariants = request.responseSchema.schema.properties.sectionResults.properties.scene.oneOf[0].properties.patches.items.oneOf;
  assert.equal(patchVariants.every((variant) => variant.required.includes("evidenceRef")), true);
  assert.equal(patchVariants.every((variant) => !variant.required.includes("evidenceRefs")), true);
  const compiled = compileDeepSeekSchema(request.responseSchema.schema);
  const serialized = JSON.stringify(compiled);
  assert.equal(serialized.includes('"evidenceRef"'), true);
  assert.equal(serialized.includes('"evidenceRefs"'), false);
});

test("compaction output schema is maintenance-only and section-specific", () => {
  const schema = buildOutputSchema("compactionProposer", ["todos"]).schema;
  assert.deepEqual(schema.properties.sectionResults.required, ["todos"]);
  const resultVariants = schema.properties.sectionResults.properties.todos.oneOf;
  assert.equal(resultVariants[0].properties.patches.items.properties.op.const, "mergeItems");
  assert.equal(resultVariants[1].properties.status.const, "unable_to_compact");
});

