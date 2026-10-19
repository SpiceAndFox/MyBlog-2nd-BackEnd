const test = require("node:test");
const assert = require("node:assert/strict");
const { shareEnumDefinitions, stripUniqueItems } = require("../../../modules/memory/infrastructure/providers/transport/schemaPolicies");
const { buildStructuredHttpRequest } = require("../../../modules/memory/infrastructure/providers/transport/structuredHttpRequest");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/output/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/output/bindOutputSchema");
const { validateLocalJsonSchema } = require("../../../modules/memory/infrastructure/providers/output/localJsonSchemaValidator");
const { providerWireSchemaMetadata } = require("../../../modules/memory/infrastructure/providers/output/providerProtocolMetadata");
const { testWriteLimits } = require("../support/memory-builders");

function librarianRequest() {
  const artifact = {
    publicInput: { task: { writeLimits: testWriteLimits() } },
    refMap: {
      writable: Object.fromEntries(Array.from({ length: 451 }, (_, i) => [`R${i + 1}`, { section: "worldFacts" }])),
      readOnly: Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`E${i + 1}`, { section: "worldFacts" }])),
    },
  };
  return {
    proposer: "librarianProposer", systemPrompt: "Return JSON", userPayload: {},
    responseSchema: bindOutputSchema(buildOutputSchema("librarianProposer"), artifact),
  };
}

function providerConfig(overrides = {}) {
  return {
    adapter: "openai-compatible-json-schema", profile: "opencode-go",
    model: "deepseek-v4.1-flash", reasoningEffort: "low",
    baseUrl: "https://gateway.test/v1", apiKey: "test-key",
    timeoutMs: 1000, maxInputTokens: 100_000, maxOutputTokens: 1024,
    ...overrides,
  };
}

function countEnumValues(node) {
  if (!node || typeof node !== "object") return 0;
  return (Array.isArray(node.enum) ? node.enum.length : 0)
    + Object.entries(node).filter(([key]) => key !== "enum").reduce((sum, [, value]) => sum + countEnumValues(value), 0);
}

// Resolve the generated local leaf references to compare the entire wire
// contract with the original, including every ref and every branch constraint.
function expandSharedDefinitions(schema) {
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.$ref) {
      assert.match(node.$ref, /^#\/\$defs\/memory_enum_\d+$/);
      const target = schema.$defs[node.$ref.split("/").at(-1)];
      assert.ok(target);
      return structuredClone(target);
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value)]));
  }
  const { $defs, ...root } = schema;
  return expand(root);
}

test("shared enums preserve literal data, existing definitions, constraints and reference scopes", () => {
  const leaf = { type: "string", enum: ["R1", "R2"] };
  const literal = { enum: ["R1", "R2"], $ref: "literal", $defs: { enum: [1, 2] } };
  const schema = {
    type: "object", additionalProperties: false, required: ["ref"],
    $defs: { memory_enum_0: { type: "integer" } },
    properties: {
      ref: structuredClone(leaf),
      refs: { type: "array", uniqueItems: true, minItems: 2, items: structuredClone(leaf) },
      enum: structuredClone(leaf),
      constrained: { ...structuredClone(leaf), minLength: 2, description: "Keep this constraint" },
      literal: { const: literal, default: literal, examples: [literal] },
      objectEnum: { enum: [literal] },
      existingRef: { $ref: "#/$defs/memory_enum_0" },
      isolated: { $id: "https://example.test/other", type: "object", properties: {
        first: structuredClone(leaf), second: structuredClone(leaf),
      } },
    },
  };
  const before = structuredClone(schema);
  const result = shareEnumDefinitions(schema);
  assert.deepEqual(schema, before);
  assert.deepEqual(result.$defs.memory_enum_0, schema.$defs.memory_enum_0);
  assert.deepEqual(result.$defs.memory_enum_1, leaf);
  for (const node of [result.properties.ref, result.properties.refs.items, result.properties.enum]) {
    assert.deepEqual(node, { $ref: "#/$defs/memory_enum_1" });
  }
  assert.equal(result.properties.refs.uniqueItems, true);
  assert.equal(result.properties.refs.minItems, 2);
  for (const key of ["constrained", "literal", "objectEnum", "existingRef", "isolated"]) {
    assert.deepEqual(result.properties[key], schema.properties[key]);
  }
  assert.deepEqual(shareEnumDefinitions(result), result);
});

test("large Librarian schemas keep every allowed value while fitting the upstream enum limit", () => {
  const request = librarianRequest();
  const before = structuredClone(request);
  const { body } = buildStructuredHttpRequest(providerConfig(), request);
  const wire = body.response_format.json_schema;
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(wire.strict, true);
  assert.equal(wire.name, request.responseSchema.name);
  assert.equal(countEnumValues(request.responseSchema.schema), 6378);
  assert.ok(countEnumValues(wire.schema) < 4000);
  assert.deepEqual(expandSharedDefinitions(wire.schema), stripUniqueItems(request.responseSchema.schema));
  assert.deepEqual(request, before);
  const definitions = Object.values(wire.schema.$defs);
  assert.ok(definitions.some(node => node.enum.length === 451 && node.enum.includes("R451")));
  assert.ok(definitions.some(node => node.enum.length === 42 && node.enum.includes("E42")));
});

test("enum sharing is a gateway policy and leaves JSON object prompts and generic schemas intact", () => {
  const request = librarianRequest();
  const generic = buildStructuredHttpRequest(providerConfig({ profile: "generic", reasoningEffort: undefined }), request);
  assert.deepEqual(generic.body.response_format.json_schema, request.responseSchema);
  const disabled = buildStructuredHttpRequest(providerConfig({ policy: { enumPolicy: "preserve" } }), request);
  assert.deepEqual(disabled.body.response_format.json_schema, stripUniqueItems(request.responseSchema));
  const object = buildStructuredHttpRequest(providerConfig({ adapter: "openai-compatible-json-object" }), request);
  assert.deepEqual(object.body.response_format, { type: "json_object" });
  assert.ok(object.body.messages[0].content.endsWith(JSON.stringify(request.responseSchema.schema)));
});

test("transport sends shared definitions but validates noop, changes and invalid refs against the original schema", async () => {
  const request = librarianRequest();
  const noop = { tickId: 1, proposer: "librarianProposer", status: "noop", operations: [] };
  const changes = { ...noop, status: "changes", operations: [
    { action: "merge", refs: ["R1", "R451"], toSection: "worldFacts", text: "Merged fact", supportRefs: ["E42"] },
  ] };
  for (const [label, output, valid] of [
    ["noop", noop, true],
    ["changes", changes, true],
    ["unknown writable ref", { ...changes, operations: [{ ...changes.operations[0], refs: ["R1", "R452"] }] }, false],
    ["unknown evidence ref", { ...changes, operations: [{ ...changes.operations[0], supportRefs: ["E43"] }] }, false],
    ["duplicate merge refs", { ...changes, operations: [{ ...changes.operations[0], refs: ["R1", "R1"] }] }, false],
    ["extra field", { ...noop, extra: true }, false],
  ]) {
    let sent;
    const invoke = createStructuredTransport(providerConfig(), {
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        // Reproduce the upstream rejection if enum sharing is omitted.
        if (countEnumValues(sent.response_format.json_schema.schema) > 4000) {
          return { ok: false, status: 400, json: async () => ({ error: { message: "This response_format type is unavailable now" } }) };
        }
        return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] }) };
      },
    });
    const result = await invoke(request);
    assert.deepEqual(sent, buildStructuredHttpRequest(providerConfig(), request).body);
    assert.equal(result.rawSchemaValid, valid, label);
    assert.equal(validateLocalJsonSchema(expandSharedDefinitions(sent.response_format.json_schema.schema), output).ok,
      label === "duplicate merge refs" ? true : valid, label);
    assert.equal(result.wireSchemaHash, providerWireSchemaMetadata(sent).wireSchemaHash);
    assert.equal(result.wireSchemaBytes, providerWireSchemaMetadata(sent).wireSchemaBytes);
    assert.deepEqual(result.output, output);
  }
});
