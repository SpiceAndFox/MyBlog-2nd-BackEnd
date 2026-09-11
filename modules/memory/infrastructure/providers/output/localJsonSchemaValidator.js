const SUPPORTED_KEYWORDS = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function schemaPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => (
        Object.prototype.hasOwnProperty.call(right, key)
        && deepEqual(left[key], right[key])
      ));
  }
  return false;
}

function assertSupportedSchema(schema, path = "$schema") {
  if (!isPlainObject(schema)) throw new Error(`Local JSON Schema at ${path} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Local JSON Schema at ${path} uses unsupported keyword: ${key}`);
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) {
      throw new Error(`Local JSON Schema ${path}.${keyword} must be a non-empty array`);
    }
    schema[keyword].forEach((branch, index) => {
      assertSupportedSchema(branch, `${path}.${keyword}[${index}]`);
    });
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      throw new Error(`Local JSON Schema ${path}.properties must be an object`);
    }
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      assertSupportedSchema(propertySchema, `${path}.properties[${JSON.stringify(key)}]`);
    }
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${path}.items`);
  if (isPlainObject(schema.additionalProperties)) {
    assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw new Error(`Local JSON Schema ${path}.additionalProperties must be a boolean or schema`);
  }
}

function matchesType(type, value) {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  throw new Error(`Local JSON Schema uses unsupported type: ${String(type)}`);
}

function validateNode(schema, value, path, errors) {
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push({ path, message: "must equal one of the allowed values" });
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      const branchErrors = [];
      validateNode(branch, value, path, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push({ path, message: "must match exactly one oneOf branch" });
  }
  if (schema.anyOf) {
    const alternatives = schema.anyOf.map((branch) => {
      const branchErrors = [];
      validateNode(branch, value, path, branchErrors);
      return { branch, errors: branchErrors };
    });
    if (!alternatives.some(entry => entry.errors.length === 0)) {
      // For a disjoint tagged union, report the selected branch's actual field
      // errors. This improves repair feedback without changing acceptance.
      const selected = isPlainObject(value) ? alternatives.find(({ branch }) => (
        Object.entries(branch.properties || {}).some(([key, property]) => (
          branch.required?.includes(key) && Array.isArray(property.enum)
          && property.enum.some(entry => deepEqual(entry, value[key]))
          && schema.anyOf.every(other => other === branch || (
            other.required?.includes(key) && Array.isArray(other.properties?.[key]?.enum)
            && property.enum.every(entry => !other.properties[key].enum.some(candidate => deepEqual(entry, candidate)))
          ))
        ))
      )) : null;
      if (selected) errors.push(...selected.errors);
      else errors.push({ path, message: "must match at least one anyOf branch" });
    }
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push({ path, message: `must be ${schema.type}; received ${valueType(value)}` });
    return;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) {
      errors.push({ path, message: `must contain at least ${schema.minLength} characters` });
    }
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
      errors.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) {
      errors.push({ path, message: `must match pattern ${schema.pattern}` });
    }
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push({ path, message: `must be greater than or equal to ${schema.minimum}` });
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push({ path, message: `must be less than or equal to ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const duplicate = value.some((entry, index) => (
        value.slice(0, index).some((previous) => deepEqual(previous, entry))
      ));
      if (duplicate) errors.push({ path, message: "must not contain duplicate items" });
    }
    if (schema.items) {
      value.forEach((entry, index) => validateNode(schema.items, entry, `${path}[${index}]`, errors));
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: schemaPath(path, key), message: "is required" });
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(properties[key], entry, schemaPath(path, key), errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: schemaPath(path, key), message: "is not allowed" });
      } else if (isPlainObject(schema.additionalProperties)) {
        validateNode(schema.additionalProperties, entry, schemaPath(path, key), errors);
      }
    }
  }
}

function validateLocalJsonSchema(schema, value) {
  assertSupportedSchema(schema);
  const errors = [];
  validateNode(schema, value, "$", errors);
  return { ok: errors.length === 0, errors };
}

module.exports = {
  assertSupportedSchema,
  validateLocalJsonSchema,
};
