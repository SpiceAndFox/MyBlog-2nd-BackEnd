const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryTestConfig, testWriteLimits, sha256 } = require("../support/memory-builders");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { buildNormalEnvelope } = require("../../../modules/memory/application/envelope");
const { resolveOutputProtocol } = require("../../../modules/memory/contracts/outputProtocol");
const { validateSemanticResult } = require("../../../modules/memory/contracts/semantic");
const { loadProposerPrompt } = require("../../../modules/memory/prompts");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/bindOutputSchema");
const { compileDeepSeekToolParameters } = require("../../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler");
const { compileDeepSeekV2Schema } = require("../../../modules/memory/infrastructure/providers/deepSeekV2SchemaCompiler");
const { flatWireToSemanticOutput } = require("../../../modules/memory/infrastructure/providers/flatWireProtocol");
const { todoV2ToSemantic, semanticToTodoV2, todoV2RepairErrors } = require("../../../modules/memory/infrastructure/providers/todoWireProtocolV2");
const { validateLocalJsonSchema } = require("../../../modules/memory/infrastructure/providers/localJsonSchemaValidator");
const { validateProviderWireOutput } = require("../../../modules/memory/infrastructure/providers/validateProviderWireOutput");
const { createStructuredTransport } = require("../../../modules/memory/infrastructure/providers/structuredTransportFactory");
const { createMemoryProviderAdapter } = require("../../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { buildProviderRequestPreviews } = require("../../../modules/memory/infrastructure/providers/providerRequestPreview");
const { createRepairFeedback, renderRepairInstruction } = require("../../../modules/memory/application/outputRepair");

const TASK = { tickId: 0, proposer: "todoProposer", targetKey: "todos", targetSections: ["todos"], outputProtocol: "todo-v2", writeLimits: testWriteLimits() };
const NOOP = { results: { todos: { status: "noop" } } };
const ADD = { action: "add", sources: ["message:101"], text: "归还图书", actor: "user", requester: "user", due: { mode: "none" } };
const EDIT = { action: "revise", sources: ["message:101"], target: "T1", text: { mode: "keep" }, actor: { mode: "keep" }, requester: { mode: "keep" }, due: { mode: "keep" } };
const CONFIG = { adapter: "deepseek-strict-tools", baseUrl: "https://api.deepseek.com/beta", apiKey: "test-key", model: "test-model", thinkingMode: "enabled", reasoningEffort: "low", timeoutMs: 1000, maxInputTokens: 250_000, maxOutputTokens: 1024 };
const changes = (...entries) => ({ results: { todos: { status: "changes", changes: entries } } });
const build = (task = TASK) => buildOutputSchema(task.proposer, task.targetSections, task);

function artifact({ targets = 1, messages = 2, memories = 1 } = {}) {
  return { publicInput: { task: TASK },
    messageMeta: Object.fromEntries(Array.from({ length: messages }, (_, i) => [101 + i, {}])),
    refMap: {
      writable: Object.fromEntries(Array.from({ length: targets }, (_, i) => [`T${i + 1}`, { section: "todos" }])),
      readOnly: Object.fromEntries(Array.from({ length: memories }, (_, i) => [`T1-E${i + 1}`, {}])),
    } };
}
function envelope() {
  return buildNormalEnvelope({ userId: 1, presetId: "default", state: createInitialMemoryState(),
    intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0 },
    messages: [{ id: 101, role: "user", createdAt: "2026-09-10T00:00:00Z", contentKind: "raw", content: "明天归还图书", contentHash: sha256("明天归还图书") }],
    now: "2026-09-10T00:00:01Z", taskId: "00000000-0000-4000-8000-000000000010", tickId: 0, config: createMemoryTestConfig(),
  });
}

test("Todo v2 preserves all 124 legacy semantic action, date and optional edit combinations", () => {
  const schema = bindOutputSchema(build(), artifact());
  const compiled = compileDeepSeekToolParameters(schema);
  const dates = [{ dueMode: "absolute", dueValue: "2026-09-11" },
    ...["relativeDays", "relativeMonths", "relativeYears", "dayOfMonth"].map(dueMode => ({ dueMode, dueValue: "1", anchorSource: "message:101" }))];
  const base = { section: "todos", sources: ["message:101", "memory:T1-E1"] };
  const entries = [{}, ...dates].map(date => ({ ...base, action: "add", text: "归还图书", actor: "user", requester: "user", ...date }));
  for (const action of ["revise", "correct"]) {
    for (const date of [{ dueMode: "keep" }, { dueMode: "clear" }, ...dates]) {
      for (let mask = 0; mask < 8; mask++) entries.push({ ...base, action, target: "T1", ...date,
        ...(mask & 1 ? { text: "归还图书" } : {}), ...(mask & 2 ? { actor: "both" } : {}), ...(mask & 4 ? { requester: "assistant" } : {}) });
    }
  }
  for (const action of ["forget", "complete", "cancel", "expire"]) entries.push({ ...base, action, target: "T1" });
  const fixtures = entries.map(entry => ({ sectionStatuses: { todos: "changes" }, changes: [entry] }));
  for (const status of ["noop", "unable_to_decide"]) fixtures.push({ sectionStatuses: { todos: status }, changes: [] });
  assert.equal(fixtures.length, 124);
  for (const flat of fixtures) {
    const semantic = flatWireToSemanticOutput(flat, TASK);
    assert.deepEqual(validateSemanticResult(semantic, TASK), { ok: true, errors: [] });
    const wire = semanticToTodoV2(semantic, TASK);
    assert.deepEqual(validateLocalJsonSchema(schema.schema, wire), { ok: true, errors: [] });
    assert.equal(validateLocalJsonSchema(compiled, wire).ok, true);
    assert.deepEqual(todoV2ToSemantic(wire, TASK), semantic);
  }
  const semanticEdit = todoV2ToSemantic(changes(EDIT), TASK).sectionResults.todos.changes[0];
  assert.equal(Object.hasOwn(semanticEdit, "text"), false, "keep must not fetch or overwrite the old value");
});

test("Todo v2 rejects mismatched fields, invalid selectors and typed date errors at precise paths", () => {
  const schema = bindOutputSchema(build(), artifact());
  const invalid = [
    { ...EDIT, target: "T999" }, { ...EDIT, text: { mode: "set" } },
    { ...EDIT, text: { mode: "keep", value: "覆盖" } }, { ...EDIT, actor: { mode: "set", value: "anyone" } },
    { ...ADD, target: "T1" }, { ...ADD, due: { mode: "keep" } }, { ...EDIT, due: { mode: "none" } },
    { ...EDIT, action: "complete" }, { ...ADD, due: { mode: "absolute", date: "明天" } },
    { ...ADD, due: { mode: "relativeDays", offset: "1", anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeDays", offset: -1, anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeMonths", offset: 0, anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeYears", offset: 1.5, anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeDays", offset: Number.MAX_SAFE_INTEGER + 1, anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeDays", offset: 1 } },
    { ...ADD, due: { mode: "dayOfMonth", day: 32, anchorSource: "message:101" } },
    { ...ADD, due: { mode: "relativeDays", offset: 1, anchorSource: "memory:T1-E1" } },
    { ...ADD, sources: ["message:999"] },
  ];
  for (const field of Object.keys(EDIT)) {
    const entry = structuredClone(EDIT);
    delete entry[field];
    invalid.push(entry);
  }
  for (const entry of invalid) {
    assert.equal(validateLocalJsonSchema(schema.schema, changes(entry)).ok, false, JSON.stringify(entry));
    assert.equal(validateLocalJsonSchema(compileDeepSeekToolParameters(schema), changes(entry)).ok, false);
  }
  const result = validateProviderWireOutput(schema, changes({ ...EDIT, actor: { mode: "set", value: "anyone" } }));
  assert.equal(result.errors[0].path, "$.results.todos.changes[0].actor.value");
  assert.equal(validateProviderWireOutput(schema, { results: { todos: { status: "noop", changes: [] } } }).ok, false);
});

test("Todo v2 keeps unsupported provider limits enforceable locally and normalizes only exact empty changes", () => {
  const context = artifact({ messages: TASK.writeLimits.todos.maxSourceRefs + 1 });
  const schema = bindOutputSchema(build(), context);
  const compiled = compileDeepSeekToolParameters(schema);
  const limit = TASK.writeLimits.todos.maxItemChars;
  assert.equal(validateProviderWireOutput(schema, changes({ ...ADD, text: "😀".repeat(limit) })).ok, true);
  for (const entry of [
    { ...ADD, text: "😀".repeat(limit + 1) }, { ...ADD, text: "" },
    { ...ADD, sources: [] }, { ...ADD, sources: ["message:101", "message:101"] },
    { ...ADD, sources: Object.keys(context.messageMeta).map(id => `message:${id}`) },
  ]) {
    assert.equal(validateLocalJsonSchema(compiled, changes(entry)).ok, true);
    assert.equal(validateProviderWireOutput(schema, changes(entry)).ok, false);
  }
  const normalized = validateProviderWireOutput(schema, changes());
  assert.equal(normalized.rawSchemaValid, false);
  assert.deepEqual(normalized.output, NOOP);
  assert.deepEqual(normalized.normalizations, [{ code: "EMPTY_CHANGES_TO_NOOP", section: "todos" }]);
  for (const extra of [{ ...changes(), extra: true }, { results: { todos: { status: "changes", changes: [], extra: true } } }]) {
    assert.equal(validateProviderWireOutput(schema, extra).ok, false);
  }
});

test("Todo v2 prunes unavailable actions and anchored dates without changing permissions", () => {
  for (const targets of [0, 1]) for (const messages of [0, 1]) for (const memories of [0, 1]) {
    const schema = bindOutputSchema(build(), artifact({ targets, messages, memories }));
    const sources = [messages ? "message:101" : "memory:T1-E1"];
    assert.equal(validateProviderWireOutput(schema, NOOP).ok, true);
    assert.equal(validateProviderWireOutput(schema, changes({ ...ADD, sources })).ok, Boolean(messages || memories));
    assert.equal(validateProviderWireOutput(schema, changes({ ...EDIT, sources })).ok, Boolean(targets && (messages || memories)));
    assert.equal(validateProviderWireOutput(schema, changes({ ...ADD, sources, due: { mode: "relativeDays", offset: 0, anchorSource: "message:101" } })).ok, Boolean(messages));
    assert.doesNotThrow(() => compileDeepSeekToolParameters(schema));
  }
});

test("Todo v2 compiler avoids optional-field expansion and reports every local-only constraint", () => {
  const context = artifact({ targets: 10, messages: 20, memories: 10 });
  const schema = bindOutputSchema(build(), context);
  const snapshot = structuredClone(schema);
  const { schema: compiled, diagnostics } = compileDeepSeekV2Schema(schema.schema);
  const legacy = compileDeepSeekToolParameters(bindOutputSchema(buildOutputSchema(TASK.proposer), context));
  assert.ok(Buffer.byteLength(JSON.stringify(compiled)) < Buffer.byteLength(JSON.stringify(legacy)) / 3);
  assert.deepEqual(schema, snapshot);
  assert.ok(diagnostics.some(entry => entry.keyword === "maxLength" && entry.value === TASK.writeLimits.todos.maxItemChars));
  assert.ok(diagnostics.every(entry => entry.enforcement === "local" && entry.providerHint === "description"));
  function inspect(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
      assert.equal(node.additionalProperties, false);
    }
    for (const key of ["oneOf", "$ref", "const", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]) assert.equal(Object.hasOwn(node, key), false);
    Object.values(node).forEach(inspect);
  }
  inspect(compiled);
  assert.throws(() => compileDeepSeekV2Schema({ ...schema.schema, not: {} }), /Unsupported/);
  assert.throws(() => compileDeepSeekV2Schema({ ...schema.schema, required: [] }), /exact required object/);
  const duplicate = schema.schema.properties.results.properties.todos.anyOf[0];
  assert.throws(() => compileDeepSeekV2Schema({ anyOf: [duplicate, duplicate] }), /disjoint/);
});

test("new Todo tasks pin v2 while restored legacy tasks retain their schema and protected prompt", async () => {
  const current = envelope();
  assert.equal(current.task.outputProtocol, "todo-v2");
  assert.equal(current.artifact.publicInput.task.outputProtocol, undefined);
  const restored = JSON.parse(JSON.stringify(current));
  assert.equal(resolveOutputProtocol(restored.task), "todo-v2");
  assert.equal(build(restored.task).name, "memory_todo_v2");
  delete restored.task.outputProtocol;
  assert.equal(resolveOutputProtocol(restored.task), "legacy-v1");
  assert.notEqual(build(restored.task).name, "memory_todo_v2");
  const oldPrompt = await loadProposerPrompt(TASK.proposer, restored.task);
  assert.equal(oldPrompt, await loadProposerPrompt(TASK.proposer));
  const prompt = await loadProposerPrompt(TASK.proposer, current.task);
  assert.notEqual(prompt, oldPrompt);
  const examples = [...prompt.matchAll(/```json\s*([\s\S]*?)\s*```/g)].map(match => JSON.parse(match[1]));
  assert.ok(examples.some(example => JSON.stringify(example) === JSON.stringify(NOOP)));
  assert.ok(examples.some(example => example.results.todos.status === "changes"));
  for (const example of examples) assert.equal(validateProviderWireOutput(bindOutputSchema(build(), artifact()), example).ok, true);
  assert.throws(() => build({ ...TASK, outputProtocol: "todo-v999" }), /Unsupported/);
  assert.throws(() => build({ ...TASK, proposer: "episodeProposer" }), /Unsupported/);
});

for (const channel of ["tool_arguments", "content", "openai_content"]) {
  test(`Todo v2 ${channel} validates the full wire schema before semantic decoding`, async () => {
    for (const candidate of [NOOP, changes(ADD), changes(), changes({ ...ADD, text: "" }), { ...NOOP, extra: true }]) {
      const taskEnvelope = envelope();
      const config = channel === "openai_content" ? { ...CONFIG, adapter: "openai-json-schema", baseUrl: "https://test.invalid/v1" } : CONFIG;
      const invokeStructured = createStructuredTransport(config, { fetchImpl: async () => ({ ok: true, json: async () => ({
        choices: [{ finish_reason: "stop", message: channel === "tool_arguments"
          ? { tool_calls: [{ function: { name: "memory_todo_v2", arguments: JSON.stringify(candidate) } }] }
          : { content: JSON.stringify(candidate) } }],
      }) }) });
      const adapter = createMemoryProviderAdapter({ invokeStructured, promptLoader: loadProposerPrompt });
      const result = await adapter.propose(taskEnvelope);
      const expected = validateProviderWireOutput(bindOutputSchema(build(), taskEnvelope.artifact), candidate);
      assert.equal(result.status, expected.ok ? "ok" : "error");
      assert.equal(result.protocol.outputChannel, channel === "openai_content" ? "content" : channel);
      assert.equal(result.protocol.rawSchemaValid, expected.rawSchemaValid);
      assert.equal(result.protocol.outputProtocol, "todo-v2");
      if (!expected.ok) assert.equal(result.detail.validationLayer, "wire_schema");
      if (expected.normalizations.length) assert.deepEqual(result.normalizations, expected.normalizations);
    }
  });
}

test("Todo v2 rejects semantic-shaped provider output and checks calendar and anchor semantics", async () => {
  for (const [output, layer] of [
    [todoV2ToSemantic(NOOP, TASK), "wire_schema"],
    [changes({ ...ADD, due: { mode: "absolute", date: "2026-02-30" } }), "semantic"],
  ]) {
    const result = await createMemoryProviderAdapter({ promptLoader: loadProposerPrompt, invokeStructured: async () => ({ output }) }).propose(envelope());
    assert.equal(result.status, "error");
    assert.equal(result.detail.validationLayer, layer);
    if (layer === "semantic") assert.equal(result.detail.errors[0].path, "$.results.todos.changes[0].due");
  }
  const wire = changes({ ...ADD, sources: ["message:102"], due: { mode: "relativeDays", offset: 1, anchorSource: "message:101" } });
  assert.equal(validateProviderWireOutput(bindOutputSchema(build(), artifact()), wire).ok, true);
  const checked = validateSemanticResult(todoV2ToSemantic(wire, TASK), TASK);
  assert.equal(checked.ok, false, "cross-field anchor membership remains a semantic constraint");
});

test("Todo v2 preview and repair use the pinned schema, prompt, and wire field names", async () => {
  const current = envelope();
  const issue = todoV2RepairErrors([{ path: "$.sectionResults.todos.changes[0].ref", message: "must be rendered as writable Memory" }], changes(EDIT));
  const feedback = createRepairFeedback({ errors: issue }, 1, current.task);
  assert.equal(feedback.errors[0].path, "$.results.todos.changes[0].target");
  assert.match(feedback.errors[0].message, /^target /);
  assert.ok(feedback.plan.expectedShape.results.todos);
  assert.match(renderRepairInstruction("prompt", feedback, current.task), /results\.todos/);
  const [initial] = await buildProviderRequestPreviews({ envelope: current, providerConfig: CONFIG, promptLoader: loadProposerPrompt });
  const [repair] = await buildProviderRequestPreviews({ envelope: current, providerConfig: CONFIG, promptLoader: loadProposerPrompt, repairFeedback: feedback, rejectedOutput: changes(EDIT) });
  assert.equal(initial.protocol.schemaHash, repair.protocol.schemaHash);
  assert.equal(initial.body.tools[0].function.name, "memory_todo_v2");
  assert.deepEqual(initial.body.tools, repair.body.tools);
  const expanded = structuredClone(current);
  expanded.artifact.messageMeta[102] = {};
  const [expandedPreview] = await buildProviderRequestPreviews({ envelope: expanded, providerConfig: CONFIG, promptLoader: loadProposerPrompt });
  assert.equal(expandedPreview.protocol.outputProtocol, "todo-v2");
  assert.notEqual(expandedPreview.protocol.schemaHash, initial.protocol.schemaHash);
  const legacy = structuredClone(current);
  delete legacy.task.outputProtocol;
  const [legacyPreview] = await buildProviderRequestPreviews({ envelope: legacy, providerConfig: CONFIG, promptLoader: loadProposerPrompt });
  assert.equal(legacyPreview.protocol.outputProtocol, "legacy-v1");
  assert.notEqual(legacyPreview.body.tools[0].function.name, "memory_todo_v2");
});

test("schema definitions count toward input budget before either provider sends a request", async () => {
  for (const adapter of ["deepseek-strict-tools", "openai-json-schema"]) {
    let called = false;
    const invoke = createStructuredTransport({ ...CONFIG, adapter, maxInputTokens: 20 }, {
      fetchImpl: async () => { called = true; throw new Error("must not fetch"); },
    });
    await assert.rejects(invoke({ systemPrompt: "x", userPayload: {}, responseSchema: build() }), error => {
      assert.equal(error.code, "MEMORY_PROVIDER_INPUT_LIMIT");
      assert.ok(error.detail.schemaUtf8Bytes > 20);
      return true;
    });
    assert.equal(called, false);
  }
});
