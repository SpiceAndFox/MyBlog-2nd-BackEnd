const { constraintDescriptions } = require("./schemaConstraintDescriptions");

const LOCAL_ONLY = new Set(["minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]);
const SUPPORTED = new Set(["type", "properties", "required", "additionalProperties", "description", "enum", "anyOf", "items", "pattern", "minimum", "maximum"]);

function compileDeepSeekV2Schema(source) {
  const diagnostics = [];
  function visit(schema, path) {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED.has(key) && !LOCAL_ONLY.has(key)) throw new Error(`Unsupported Todo v2 schema keyword ${path}.${key}`);
    }
    if (schema.type === "object") {
      const names = Object.keys(schema.properties || {});
      if (schema.additionalProperties !== false || names.length !== schema.required?.length || names.some(name => !schema.required.includes(name))) {
        throw new Error(`Todo v2 schema requires an exact required object at ${path}`);
      }
    }
    if (schema.anyOf) {
      const branches = schema.anyOf;
      for (let i = 0; i < branches.length; i++) {
        if (branches[i].type !== "object") throw new Error(`Todo v2 union requires object branches at ${path}`);
        for (let j = 0; j < i; j++) {
          const disjoint = Object.entries(branches[i].properties).some(([key, value]) => {
            const other = branches[j].properties[key];
            return branches[i].required.includes(key) && branches[j].required.includes(key)
              && value.enum && other?.enum && value.enum.every(entry => !other.enum.includes(entry));
          });
          if (!disjoint) throw new Error(`Todo v2 union requires disjoint discriminators at ${path}`);
        }
      }
    }
    const compiled = {};
    for (const [key, value] of Object.entries(schema)) {
      if (LOCAL_ONLY.has(key)) {
        diagnostics.push({ path, keyword: key, value, enforcement: "local", providerHint: "description" });
      } else if (key === "properties") compiled.properties = Object.fromEntries(Object.entries(value).map(([name, node]) => [name, visit(node, `${path}.properties.${name}`)]));
      else if (key === "anyOf") compiled.anyOf = value.map((node, i) => visit(node, `${path}.anyOf[${i}]`));
      else if (key === "items") compiled.items = visit(value, `${path}.items`);
      else compiled[key] = structuredClone(value);
    }
    const descriptions = constraintDescriptions(schema);
    if (descriptions.length) compiled.description = [compiled.description, ...descriptions].filter(Boolean).join(" ");
    return compiled;
  }
  return { schema: visit(source, "$"), diagnostics };
}

module.exports = { compileDeepSeekV2Schema };
