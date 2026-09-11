// Transform schema nodes only; property names and literal const/enum/default
// values can themselves contain a key named uniqueItems and must be preserved.
function stripUniqueItems(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = structuredClone(schema);
  delete result.uniqueItems;
  if (schema.uniqueItems === true) {
    result.description = [schema.description, "Array items must be unique."].filter(Boolean).join(" ");
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    if (schema[key]) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, node]) => [name, stripUniqueItems(node)]));
  }
  for (const key of ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "schema"]) {
    if (schema[key] && !Array.isArray(schema[key])) result[key] = stripUniqueItems(schema[key]);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map(stripUniqueItems);
  }
  return result;
}

module.exports = { stripUniqueItems };
