const test = require("node:test");
const assert = require("node:assert/strict");
const { testWriteLimits } = require("../support/memory-builders");
const { loadProposerPrompt } = require("../../../modules/memory/prompts");
const { validateSemanticResult } = require("../../../modules/memory/contracts/semantic");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/bindOutputSchema");
const {
  compileDeepSeekSchema,
  compileDeepSeekToolParameters,
} = require("../../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler");
const { flatWireToSemanticOutput } = require("../../../modules/memory/infrastructure/providers/flatWireProtocol");
const {
  validateLocalJsonSchema,
} = require("../../../modules/memory/infrastructure/providers/localJsonSchemaValidator");
const { buildDeepSeekHttpRequest } = require("../../../modules/memory/infrastructure/providers/structuredHttpRequest");

const TASK = {
  tickId: 0,
  proposer: "todoProposer",
  targetKey: "todos",
  targetSections: ["todos"],
  writeLimits: testWriteLimits(),
};
const BASE = { section: "todos", sources: ["message:101"] };
const ADD = { ...BASE, action: "add", text: "归还图书", actor: "user", requester: "user" };
const EDIT = { ...BASE, action: "revise", target: "T1", dueMode: "keep" };
const DATES = [
  { dueMode: "absolute", dueValue: "2026-09-11" },
  { dueMode: "relativeDays", dueValue: "0", anchorSource: "message:101" },
  { dueMode: "relativeMonths", dueValue: "1", anchorSource: "message:101" },
  { dueMode: "relativeYears", dueValue: "1", anchorSource: "message:101" },
  { dueMode: "dayOfMonth", dueValue: "15", anchorSource: "message:101" },
];

function output(change) {
  return { sectionStatuses: { todos: "changes" }, changes: [change] };
}

function boundSchema({ writable = true, messages = true } = {}) {
  return bindOutputSchema(buildOutputSchema(TASK.proposer), {
    publicInput: { task: TASK },
    refMap: { writable: writable ? { T1: { section: "todos" } } : {}, readOnly: { "T1-E1": {} } },
    messageMeta: messages ? { 101: {} } : {},
  });
}

test("DeepSeek Todo tool schema stays compact and satisfies strict object/union rules", () => {
  const source = buildOutputSchema(TASK.proposer);
  const snapshot = structuredClone(source);
  const compiled = compileDeepSeekToolParameters(source);
  const originalBytes = Buffer.byteLength(JSON.stringify(compileDeepSeekSchema(source.schema)));
  const compiledBytes = Buffer.byteLength(JSON.stringify(compiled));
  assert.ok(compiledBytes < originalBytes / 3, `${compiledBytes} vs ${originalBytes} bytes`);
  assert.ok(compiled.properties.changes.items.anyOf.length <= 32);
  assert.deepEqual(source, snapshot, "provider specialization must not mutate the shared schema");

  function inspect(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
    }
    if (node.anyOf) assert.ok(node.anyOf.every((branch) => branch.type || branch.$ref));
    if (node.enum) assert.equal(typeof node.type, "string");
    for (const key of ["oneOf", "const", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]) {
      assert.equal(Object.hasOwn(node, key), false, key);
    }
    Object.values(node).forEach(inspect);
  }
  inspect(compiled);
});

test("DeepSeek Todo accepts every supported action/date and partial edit field combination", () => {
  const compiled = compileDeepSeekToolParameters(boundSchema());
  const cases = [{ ...ADD }, ...DATES.map((date) => ({ ...ADD, ...date }))];
  for (const action of ["revise", "correct"]) {
    for (const date of [{ dueMode: "keep" }, { dueMode: "clear" }, ...DATES]) {
      for (let mask = 0; mask < 8; mask += 1) {
        cases.push({
          ...BASE,
          action,
          target: "T1",
          ...date,
          ...(mask & 1 ? { text: "归还图书" } : {}),
          ...(mask & 2 ? { actor: "both" } : {}),
          ...(mask & 4 ? { requester: "assistant" } : {}),
        });
      }
    }
  }
  for (const action of ["forget", "complete", "cancel", "expire"]) {
    cases.push({ ...BASE, action, target: "T1" });
  }
  for (const change of cases) {
    const value = output(change);
    assert.deepEqual(validateSemanticResult(flatWireToSemanticOutput(value, TASK), TASK), { ok: true, errors: [] });
    assert.equal(validateLocalJsonSchema(compiled, value).ok, true, JSON.stringify(change));
  }
  for (const status of ["noop", "unable_to_decide"]) {
    assert.equal(validateLocalJsonSchema(compiled, { sectionStatuses: { todos: status }, changes: [] }).ok, true);
  }
});

test("DeepSeek Todo rejects mismatched action fields and incomplete date groups", () => {
  const compiled = compileDeepSeekToolParameters(boundSchema());
  const invalid = [
    { ...ADD, target: "T1" },
    { ...ADD, dueMode: "keep" },
    { ...ADD, dueMode: "clear" },
    { ...ADD, dueValue: "1" },
    { ...ADD, dueMode: "absolute" },
    { ...ADD, ...DATES[0], anchorSource: "message:101" },
    { ...ADD, dueMode: "relativeDays", dueValue: "1" },
    { ...ADD, dueMode: "dayOfMonth", anchorSource: "message:101" },
    { ...ADD, anchorSource: "message:101" },
    { ...EDIT, dueValue: "1" },
    { ...EDIT, anchorSource: "message:101" },
    { ...EDIT, dueMode: "relativeMonths", dueValue: "1" },
    { ...BASE, action: "complete", target: "T1", text: "已归还" },
    { ...BASE, action: "cancel", target: "T1", actor: "user" },
    { ...BASE, action: "expire", target: "T1", dueMode: "keep" },
  ];
  for (const field of ["text", "actor", "requester", "sources"]) {
    const candidate = { ...ADD };
    delete candidate[field];
    invalid.push(candidate);
  }
  for (const field of ["target", "dueMode"]) {
    const candidate = { ...EDIT };
    delete candidate[field];
    invalid.push(candidate);
  }
  for (const change of invalid) {
    assert.equal(validateLocalJsonSchema(compiled, output(change)).ok, false, JSON.stringify(change));
  }
});

test("DeepSeek Todo HTTP requests retain bound selectors and exclude unavailable branches", () => {
  for (const thinkingMode of ["enabled", "disabled"]) {
    for (const writable of [true, false]) {
      for (const messages of [true, false]) {
        const responseSchema = boundSchema({ writable, messages });
        const snapshot = structuredClone(responseSchema);
        const { body, endpoint } = buildDeepSeekHttpRequest(
          {
            baseUrl: "https://api.deepseek.com/beta",
            model: "deepseek-flash",
            thinkingMode,
            reasoningEffort: "low",
            maxOutputTokens: 4096,
          },
          { proposer: TASK.proposer, systemPrompt: "Return the Todo result", userPayload: {}, responseSchema },
        );
        assert.equal(endpoint, "https://api.deepseek.com/beta/chat/completions");
        assert.equal(body.tools[0].function.strict, true);
        const compiled = body.tools[0].function.parameters;
        assert.deepEqual(responseSchema, snapshot);
        for (const branch of compiled.properties.changes.items.anyOf) {
          const properties = branch.properties;
          assert.deepEqual(
            properties.sources.items.enum,
            messages ? ["message:101", "memory:T1-E1"] : ["memory:T1-E1"],
          );
          if (properties.target) assert.deepEqual(properties.target.enum, ["T1"]);
          if (!writable) assert.deepEqual(properties.action.enum, ["add"]);
          if (properties.anchorSource) assert.deepEqual(properties.anchorSource.enum, ["message:101"]);
          if (!messages) assert.equal(properties.anchorSource, undefined);
          if (properties.text)
            assert.match(
              properties.text.description,
              new RegExp(`at most ${TASK.writeLimits.todos.maxItemChars} Unicode characters`),
            );
          assert.match(
            properties.sources.description,
            new RegExp(`at most ${TASK.writeLimits.todos.maxSourceRefs} items`),
          );
        }
        const candidate = { ...ADD, sources: [messages ? "message:101" : "memory:T1-E1"] };
        assert.equal(validateLocalJsonSchema(compiled, output(candidate)).ok, true);
        assert.equal(validateLocalJsonSchema(compiled, output({ ...candidate, sources: ["message:999"] })).ok, false);
        assert.equal(validateLocalJsonSchema(compiled, output({ ...EDIT, target: "T999" })).ok, false);
        assert.equal(validateLocalJsonSchema(compiled, output(EDIT)).ok, writable && messages);
        assert.equal(validateLocalJsonSchema(compiled, output({ ...ADD, ...DATES[1] })).ok, messages);
        assert.equal(
          validateLocalJsonSchema(compiled, output({ ...ADD, ...DATES[1], anchorSource: "message:999" })).ok,
          false,
        );
      }
    }
  }
});

test("DeepSeek Todo keeps the protected prompt examples compatible", async () => {
  const prompt = await loadProposerPrompt(TASK.proposer);
  const examples = [...prompt.matchAll(/```json\s*([\s\S]*?)\s*```/g)].map((match) => JSON.parse(match[1]));
  assert.ok(examples.length >= 2);
  const compiled = compileDeepSeekToolParameters(boundSchema());
  for (const example of examples)
    assert.deepEqual(validateLocalJsonSchema(compiled, example), { ok: true, errors: [] });
});

test("DeepSeek Todo specialization leaves other flat proposer schemas unchanged", () => {
  for (const proposer of [
    "currentStateProposer",
    "episodeProposer",
    "userProfileProposer",
    "agreementProposer",
    "worldFactProposer",
  ]) {
    const source = buildOutputSchema(proposer);
    assert.deepEqual(compileDeepSeekToolParameters(source), compileDeepSeekSchema(source.schema));
  }
});
