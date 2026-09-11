const { constraintDescriptions } = require("../output/schemaConstraintDescriptions");
const { compileDeepSeekTodoSchema } = require("./deepSeekTodoSchemaCompiler");
const { TODO_SCHEMA_NAME } = require("../output/todoWireProtocol");

const DROPPED_KEYWORDS = new Set(["minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]);

function literalType(value) {
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  if (["string", "boolean"].includes(typeof value)) return typeof value;
  return null;
}

function enumType(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const types = new Set(values.map(literalType));
  return types.size === 1 ? [...types][0] : null;
}

function compileUnion(values) {
  return values.flatMap((value) => {
    const compiled = compileDeepSeekSchema(value);
    // DeepSeek requires each direct anyOf branch to declare a type (or $ref).
    // Flatten schema-only nested unions produced when an object with optional
    // properties is itself one branch of a business union.
    if (compiled && Object.keys(compiled).length === 1 && Array.isArray(compiled.anyOf)) return compiled.anyOf;
    return [compiled];
  });
}

function subsets(values) {
  if (values.length > 8) throw new Error("DeepSeek strict schema has too many optional properties to expand safely");
  const result = [];
  for (let mask = 0; mask < 2 ** values.length; mask += 1) {
    result.push(values.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return result;
}

function isRequiredClause(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => key === "required") && Array.isArray(value.required);
}

function compileObject(schema) {
  const properties = schema.properties || {};
  const propertyNames = Object.keys(properties);
  const required = new Set(schema.required || []);
  const optional = propertyNames.filter((name) => !required.has(name));
  const requiredClauses = Array.isArray(schema.anyOf) && schema.anyOf.every(isRequiredClause) ? schema.anyOf : null;
  const variants = subsets(optional).filter((selected) => {
    if (!requiredClauses) return true;
    const included = new Set([...required, ...selected]);
    return requiredClauses.some((clause) => clause.required.every((name) => included.has(name)));
  }).map((selected) => {
    const included = [...propertyNames.filter((name) => required.has(name)), ...selected];
    const compiledProperties = Object.fromEntries(included.map((name) => [name, compileDeepSeekSchema(properties[name])]));
    return { type: "object", additionalProperties: false, properties: compiledProperties, required: included };
  });
  if (variants.length === 0) throw new Error("DeepSeek strict schema object has no valid required-property variant");
  if (variants.length === 1) return variants[0];
  return { anyOf: variants };
}

function compileDeepSeekSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (schema.type === "object" || schema.properties) return compileObject(schema);
  const compiled = {};
  const descriptions = constraintDescriptions(schema);
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "const") {
      compiled.enum = [value];
      continue;
    }
    if (key === "oneOf") {
      compiled.anyOf = compileUnion(value);
      continue;
    }
    if (key === "anyOf") {
      compiled.anyOf = compileUnion(value);
      continue;
    }
    if (key === "items") {
      compiled.items = compileDeepSeekSchema(value);
      continue;
    }
    compiled[key] = value;
  }
  if (descriptions.length) {
    compiled.description = [compiled.description, ...descriptions].filter(Boolean).join(" ");
  }
  // DeepSeek strict tools reject enum-only schema nodes. JSON Schema permits
  // both `const` and `enum` without an explicit type, so add the type when all
  // literals share one representable primitive type.
  if (!compiled.type && compiled.enum) {
    const type = enumType(compiled.enum);
    if (!type) throw new Error("DeepSeek strict schema enum values must share one primitive type");
    compiled.type = type;
  }
  return compiled;
}

function compileDeepSeekToolParameters(responseSchema) {
  if (responseSchema.name === TODO_SCHEMA_NAME) return compileDeepSeekTodoSchema(responseSchema.schema).schema;
  if (responseSchema.name !== "memory_librarian_semantic") return compileDeepSeekSchema(responseSchema.schema);
  // Strict tools require one root object. Keep status/operations coupling in
  // local semantic validation; transport always emits reports (empty if none).
  const branches = responseSchema.schema.oneOf;
  const changes = branches.find(branch => branch.properties.status.const === "changes");
  const properties = structuredClone(branches[0].properties);
  properties.status = { type: "string", enum: branches.map(branch => branch.properties.status.const) };
  properties.operations = changes
    ? { ...structuredClone(changes.properties.operations), minItems: 0, description: "Use an empty array for noop; changes requires at least one operation." }
    : structuredClone(properties.operations);
  return compileDeepSeekSchema({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
}

module.exports = { compileDeepSeekSchema, compileDeepSeekToolParameters, constraintDescriptions };
