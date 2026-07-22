const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDueAtSchema, validateDueAtExpression } = require("../../../modules/memory/contracts/dueAt");
const { compileDeepSeekSchema } = require("../../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler");

function matchesSchema(schema, value) {
  if (schema.oneOf) return schema.oneOf.filter((branch) => matchesSchema(branch, value)).length === 1;
  if (schema.anyOf) return schema.anyOf.some((branch) => matchesSchema(branch, value));
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const properties = schema.properties || {};
    if ((schema.required || []).some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.prototype.hasOwnProperty.call(value, key) || matchesSchema(child, value[key]));
  }
  if (schema.type === "integer" && !Number.isSafeInteger(value)) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (schema.maximum !== undefined && value > schema.maximum) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  return true;
}

test("Provider dueAt schema and local validator agree on canonical structural boundaries", () => {
  const cases = [
    [{ mode: "absolute", date: "2026-07-15" }, true],
    [{ mode: "relative", days: 0 }, true],
    [{ mode: "relative", days: 1 }, true],
    [{ mode: "relative", months: 1 }, true],
    [{ mode: "relative", years: 1 }, true],
    [{ mode: "dayOfMonth", day: 9 }, true],
    [{ mode: "dayOfMonth", day: 1 }, true],
    [{ mode: "dayOfMonth", day: 31 }, true],
    [{ mode: "dayOfMonth", day: 0 }, false],
    [{ mode: "dayOfMonth", day: 32 }, false],
    [{ mode: "dayOfMonth" }, false],
    [{ mode: "dayOfMonth", day: 9, month: 8 }, false],
    [{ mode: "relative", days: -1 }, false],
    [{ mode: "relative", months: 0 }, false],
    [{ mode: "relative", years: 0 }, false],
    [{ mode: "relative" }, false],
    [{ mode: "relative", days: 1, months: 1 }, false],
    [{ mode: "relative", days: 0, months: 0 }, false],
    [{ mode: "relative", hours: 1 }, false],
    [{ mode: "calendarDay", day: 9 }, false],
    [null, false],
    ["today", false],
  ];
  const schema = buildDueAtSchema();
  const compiledSchema = compileDeepSeekSchema(schema);
  for (const [value, expected] of cases) {
    assert.equal(matchesSchema(schema, value), expected, `Provider schema disagreement for ${JSON.stringify(value)}`);
    assert.equal(matchesSchema(compiledSchema, value), expected, `compiled DeepSeek schema disagreement for ${JSON.stringify(value)}`);
    assert.equal(validateDueAtExpression(value).length === 0, expected, `local validator disagreement for ${JSON.stringify(value)}`);
  }
});

test("calendar validity remains a deliberate local semantic repair boundary", () => {
  const impossible = { mode: "absolute", date: "2026-02-31" };
  assert.equal(matchesSchema(buildDueAtSchema(), impossible), true, "JSON Schema only guarantees the YYYY-MM-DD shape");
  assert.match(validateDueAtExpression(impossible)[0].message, /valid YYYY-MM-DD/);
});
