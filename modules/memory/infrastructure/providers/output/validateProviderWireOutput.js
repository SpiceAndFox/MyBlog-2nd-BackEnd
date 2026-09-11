const { validateLocalJsonSchema } = require("./localJsonSchemaValidator");
const { isDeepStrictEqual } = require("node:util");
const { TODO_SCHEMA_NAME } = require("./todoWireProtocol");

function validateProviderWireOutput(responseSchema, output) {
  const validation = validateLocalJsonSchema(responseSchema.schema, output);
  if (validation.ok) return { ...validation, output, rawSchemaValid: true, normalizations: [] };
  // Preserve only the existing empty-changes -> noop normalization. Match the
  // entire envelope first so this never hides unknown fields or other errors.
  if (responseSchema.name === TODO_SCHEMA_NAME
    && isDeepStrictEqual(output, { results: { todos: { status: "changes", changes: [] } } })) {
    const normalized = { results: { todos: { status: "noop" } } };
    if (validateLocalJsonSchema(responseSchema.schema, normalized).ok) {
      return { ok: true, errors: [], output: normalized, rawSchemaValid: false,
        normalizations: [{ code: "EMPTY_CHANGES_TO_NOOP", section: "todos" }] };
    }
  }
  return { ...validation, output, rawSchemaValid: false, normalizations: [] };
}

module.exports = { validateProviderWireOutput };
