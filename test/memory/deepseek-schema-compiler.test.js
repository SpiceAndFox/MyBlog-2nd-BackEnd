const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOutputSchema } = require("../../modules/memory/infrastructure/providers/outputSchema");
const { compileDeepSeekSchema } = require("../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler");

test("DeepSeek compiler preserves optional object fields as strict anyOf variants", () => {
  const source = buildOutputSchema("todoProposer").schema;
  const compiled = compileDeepSeekSchema(source);
  const seen = new Set();
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) seen.add(key);
    if (value.enum) assert.equal(typeof value.type, "string", "DeepSeek enum schema requires an explicit type");
    if (value.anyOf) {
      assert.equal(value.anyOf.every((variant) => variant.type || variant.$ref), true, "DeepSeek anyOf branches require a type or $ref");
    }
    if (value.type === "object") {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual(new Set(value.required), new Set(Object.keys(value.properties)));
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(inspect);
      else inspect(child);
    }
  }
  inspect(compiled);
  for (const unsupported of ["oneOf", "const", "minLength", "maxLength", "minItems", "uniqueItems"]) {
    assert.equal(seen.has(unsupported), false, `compiled schema contains ${unsupported}`);
  }
  assert.equal(seen.has("anyOf"), true);
});

test("DeepSeek compiler adds primitive types to const and enum schemas", () => {
  assert.deepEqual(compileDeepSeekSchema({ const: "noop" }), { enum: ["noop"], type: "string" });
  assert.deepEqual(compileDeepSeekSchema({ enum: [1, 2] }), { enum: [1, 2], type: "integer" });
  assert.throws(() => compileDeepSeekSchema({ enum: ["one", 2] }), /must share one primitive type/);
});

