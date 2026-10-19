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

// Visit schema positions only: enum/const/default values and property names are
// data, even when they happen to look like schemas. Nested $id resources have
// their own reference scope and cannot point at the root's shared definitions.
function visitSchemaNodes(schema, visit, root = schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema !== root && Object.hasOwn(schema, "$id")) return;
  visit(schema);
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    for (const node of Object.values(schema[key] || {})) visitSchemaNodes(node, visit, root);
  }
  for (const key of ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    if (!Array.isArray(schema[key])) visitSchemaNodes(schema[key], visit, root);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
    if (Array.isArray(schema[key])) schema[key].forEach(node => visitSchemaNodes(node, visit, root));
  }
}

function shareEnumDefinitions(schema) {
  const result = structuredClone(schema);
  const groups = new Map();
  visitSchemaNodes(result, node => {
    // Only hoist enum leaves. Moving a schema with refs, identifiers or child
    // schemas could change reference resolution or discard sibling constraints.
    if (!Array.isArray(node.enum) || !node.enum.length
      || Object.keys(node).some(key => key !== "enum" && key !== "type")) return;
    const key = JSON.stringify({ type: node.type, enum: node.enum });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });
  let index = 0;
  for (const nodes of groups.values()) {
    if (nodes.length < 2) continue;
    result.$defs ||= {};
    let name;
    do { name = `memory_enum_${index++}`; } while (Object.hasOwn(result.$defs, name));
    result.$defs[name] = structuredClone(nodes[0]);
    for (const node of nodes) {
      for (const key of Object.keys(node)) delete node[key];
      node.$ref = `#/$defs/${name}`;
    }
  }
  return result;
}

module.exports = { stripUniqueItems, shareEnumDefinitions };
