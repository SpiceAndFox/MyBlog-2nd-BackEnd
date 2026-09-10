const test = require("node:test");
const assert = require("node:assert/strict");
const { providerBusinessRejection } = require("../../../modules/memory/infrastructure/providers/providerBusinessRejection");
const { todoV2ToSemantic } = require("../../../modules/memory/infrastructure/providers/todoWireProtocolV2");
const { createRepairFeedback, renderRepairMessage, appendRejectedOutputAttempt, latestRejectedOutput } = require("../../../modules/memory/application/outputRepair");
const { testWriteLimits } = require("../support/memory-builders");

const TASK = { proposer: "todoProposer", outputProtocol: "todo-v2", tickId: 1, targetKey: "todos", targetSections: ["todos"], writeLimits: testWriteLimits() };
const WIRE = { results: { todos: { status: "changes", changes: [
  { action: "complete", target: "T1", sources: ["message:1"] },
  { action: "revise", target: "T9", sources: ["message:2"], text: { mode: "keep" }, actor: { mode: "set", value: "user" }, requester: { mode: "keep" }, due: { mode: "absolute", date: "2026-10-01" } },
] } } };

test("business feedback maps later changes and participant values to v2 and survives persisted retry", () => {
  const result = { output: todoV2ToSemantic(WIRE, TASK), wireOutput: WIRE, protocol: { outputProtocol: "todo-v2", rawSchemaValid: true, schemaHash: "hash" } };
  const mapped = providerBusinessRejection(result, { validationLayer: "business", errors: [{
    code: "TODO_OVERDUE_PARTICIPANT_CHANGE", path: "$.sectionResults.todos.changes[1].actor", message: "invalid_state_transition",
    meta: { field: "actor", currentValue: "assistant", proposedValue: "user", currentStatus: "overdue", secret: "must-not-leak" },
  }] }, TASK);
  const feedback = createRepairFeedback({ ...mapped, validationLayer: "business" }, 1, TASK);
  assert.equal(feedback.errors[0].path, "$.results.todos.changes[1].actor.value");
  assert.equal(feedback.errors[0].meta.target, "T9");
  assert.deepEqual(feedback.plan.directives, ["RETURN_COMPLETE_REPLACEMENT", "PRESERVE_OVERDUE_PARTICIPANTS"]);
  const message = renderRepairMessage(feedback, TASK);
  for (const text of ['target="T9"', '原值="assistant"', '候选值="user"', '{"mode":"keep"}']) assert.ok(message.includes(text), text);
  assert.doesNotMatch(message, /sectionResults|must-not-leak/);
  const stored = appendRejectedOutputAttempt({}, { ...result, ...mapped }, 0, 2);
  const restored = JSON.parse(JSON.stringify({ stored, feedback }));
  assert.deepEqual(latestRejectedOutput(restored.stored), WIRE);
  assert.equal(restored.stored.schemaRejectedOutputs[0].protocol.schemaHash, "hash");
  assert.equal(renderRepairMessage(restored.feedback, TASK), message);
});

test("source-limit and duplicate rejections produce field-specific corrective instructions", () => {
  const result = { output: todoV2ToSemantic(WIRE, TASK), wireOutput: WIRE };
  const mapped = providerBusinessRejection(result, { errors: [
    { code: "SOURCE_LIMIT_EXCEEDED", path: "$.sectionResults.todos.changes[1].evidenceMessageIds", message: "source_limit_exceeded", meta: { limit: 2, actual: 3 } },
    { code: "DUPLICATE_ITEM", path: "$.sectionResults.todos.changes[1].text", message: "duplicate_item" },
  ] }, TASK);
  const feedback = createRepairFeedback(mapped, 1, TASK);
  assert.equal(feedback.errors[0].path, "$.results.todos.changes[1].sources");
  assert.equal(feedback.errors[1].path, "$.results.todos.changes[1].text.value");
  const message = renderRepairMessage(feedback, TASK);
  assert.match(message, /本次选择了 3 条来源，上限为 2/);
  assert.match(message, /保留其他合法修改/);
  assert.doesNotMatch(message, /sectionResults|evidenceMessageIds/);
});

test("injected adapters re-encode valid semantic fixtures explicitly and never send malformed IR as Todo v2", () => {
  const output = todoV2ToSemantic(WIRE, TASK);
  const validation = { errors: [{ path: "$.sectionResults.todos.changes[1].dueChange", message: "invalid_state_transition" }] };
  const reencoded = providerBusinessRejection({ output }, validation, TASK);
  assert.deepEqual(reencoded.rejectedOutput, WIRE);
  assert.equal(reencoded.rejectedOutputKind, "semantic_reencoded");
  const malformed = providerBusinessRejection({ output: null }, validation, TASK);
  assert.equal(malformed.rejectedOutput, undefined);
  assert.equal(malformed.rejectedOutputKind, "unavailable");
  const legacy = { ...TASK, outputProtocol: "legacy-v1" };
  const legacyResult = providerBusinessRejection({ output }, validation, legacy);
  assert.ok(legacyResult.rejectedOutput.sectionStatuses);
  assert.equal(legacyResult.errors[0].path, "$.changes[1].dueMode");
});
