const DROPPED_KEYWORDS = new Set(["minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]);

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
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "const") {
      compiled.enum = [value];
      continue;
    }
    if (key === "oneOf") {
      compiled.anyOf = value.map(compileDeepSeekSchema);
      continue;
    }
    if (key === "anyOf") {
      compiled.anyOf = value.map(compileDeepSeekSchema);
      continue;
    }
    if (key === "items") {
      compiled.items = compileDeepSeekSchema(value);
      continue;
    }
    compiled[key] = value;
  }
  return compiled;
}

module.exports = { compileDeepSeekSchema };
