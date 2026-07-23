const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/bindOutputSchema");
const { sceneEnvelope } = require("../support/provider-envelopes");

test("generic schema binding restricts refs and evidence ids to the rendered artifact", () => {
  const envelope = sceneEnvelope();
  const bound = bindOutputSchema(
    buildOutputSchema("currentStateProposer", ["scene"]),
    envelope.artifact,
    ["scene"],
  );
  const changesBranch = bound.schema.properties.sectionResults.properties.scene.oneOf
    .find((branch) => branch.properties?.status?.const === "changes");
  const variants = changesBranch.properties.changes.items.oneOf;

  assert.ok(variants.length > 0);
  assert.ok(variants.every((variant) => (
    JSON.stringify(variant.properties.ref.enum)
      === JSON.stringify(["S-LOCATION", "S-MOOD", "S-NOTE", "S-TIME"])
  )));
  assert.ok(variants.every((variant) => (
    JSON.stringify(variant.properties.evidenceMessageIds.items.enum) === JSON.stringify([1])
  )));
  assert.ok(variants.every((variant) => !Object.hasOwn(variant.properties, "supportRefs")));
});

test("generic schema binding also restricts compaction merge refs", () => {
  const bound = bindOutputSchema(
    buildOutputSchema("compactionProposer", ["todos"]),
    {
      refMap: {
        writable: {
          T2: { section: "todos" },
          T1: { section: "todos" },
          A1: { section: "standingAgreements" },
        },
        readOnly: {},
      },
      messageMeta: {},
    },
    ["todos"],
  );
  const refs = bound.schema.properties.sectionResults.properties.todos.oneOf[0]
    .properties.changes.items.properties.refs.items;
  assert.deepEqual(refs, { type: "string", enum: ["T1", "T2"] });
});
