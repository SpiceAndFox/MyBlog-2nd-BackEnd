const { testWriteLimits } = require("../support/memory-builders");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/bindOutputSchema");
const { sceneEnvelope } = require("../support/provider-envelopes");

test("generic schema binding restricts flat targets and sources to the rendered artifact", () => {
  const envelope = sceneEnvelope();
  const bound = bindOutputSchema(
    buildOutputSchema("currentStateProposer", ["scene"]),
    envelope.artifact,
    ["scene"],
  );
  const properties = bound.schema.properties.changes.items.properties;
  assert.deepEqual(properties.target.enum, ["S-LOCATION", "S-MOOD", "S-NOTE", "S-TIME"]);
  assert.deepEqual(properties.sources.items.enum, ["message:1"]);
  assert.equal(Object.hasOwn(properties, "evidenceMessageIds"), false);
  assert.equal(Object.hasOwn(properties, "supportRefs"), false);
});

test("generic schema binding also restricts compaction merge refs", () => {
  const bound = bindOutputSchema(
    buildOutputSchema("compactionProposer", ["todos"]),
    {
      publicInput: { task: { writeLimits: testWriteLimits() } },
      refMap: {
        writable: {
          T2: { section: "todos" },
          T1: { section: "todos" },
          A1: { section: "standingAgreements" },
        },
        readOnly: { "T1-E1": { section: "todos" } },
      },
      messageMeta: {},
    },
    ["todos"],
  );
  const refs = bound.schema.properties.sectionResults.properties.todos.oneOf[0]
    .properties.changes.items.properties.refs.items;
  assert.deepEqual(refs, { type: "string", enum: ["T1", "T2"] });
});

test("flat binding disables impossible changes when no visible source exists", () => {
  const bound = bindOutputSchema(
    buildOutputSchema("currentStateProposer", ["scene"]),
    {
      publicInput: { task: { writeLimits: testWriteLimits() } },
      refMap: { writable: {}, readOnly: {} },
      messageMeta: {},
    },
    ["scene"],
  );
  assert.equal(bound.schema.properties.changes.maxItems, 0);
  assert.equal(Object.hasOwn(bound.schema.properties.changes.items.properties, "target"), false);
});
