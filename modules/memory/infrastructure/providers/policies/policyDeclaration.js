const { REASONING_EFFORT_VALUES, THINKING_MODE_VALUES } = require("../../../config/providerSettingValues");

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const DEFAULT_POLICY = deepFreeze({
  reasoningEncoding: "none",
  reasoningEfforts: REASONING_EFFORT_VALUES,
  thinkingModes: THINKING_MODE_VALUES,
  schemaPolicy: "preserve",
  outputModes: ["json_schema", "json_object"],
  outputTokenField: "max_tokens",
  repairRole: "assistant",
});

const ENUM_FIELDS = {
  reasoningEncoding: ["none", "reasoning-effort", "thinking", "openrouter"],
  schemaPolicy: ["preserve", "strip-unique-items"],
  outputTokenField: ["max_tokens", "max_completion_tokens"],
  repairRole: ["assistant", "user-diagnostic"],
};
const ARRAY_FIELDS = {
  reasoningEfforts: REASONING_EFFORT_VALUES,
  thinkingModes: THINKING_MODE_VALUES,
  outputModes: ["json_schema", "json_object"],
};

function validatePolicyDeclaration(value, label = "provider policy") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(ENUM_FIELDS, key)) {
      if (!ENUM_FIELDS[key].includes(entry)) throw new Error(`${label}.${key} must be one of: ${ENUM_FIELDS[key].join(", ")}`);
    } else if (Object.hasOwn(ARRAY_FIELDS, key)) {
      if (!Array.isArray(entry) || (key !== "reasoningEfforts" && entry.length === 0)
        || entry.some((item) => !ARRAY_FIELDS[key].includes(item)) || new Set(entry).size !== entry.length) {
        throw new Error(`${label}.${key} must be an array of unique supported values`);
      }
    } else throw new Error(`${label} contains unsupported key: ${key}`);
  }
  return deepFreeze(structuredClone(value));
}


module.exports = { DEFAULT_POLICY, validatePolicyDeclaration };
