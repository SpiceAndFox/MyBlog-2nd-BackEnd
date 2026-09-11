const test = require("node:test");
const assert = require("node:assert/strict");
const { providerBusinessRejection } = require("../../../modules/memory/infrastructure/providers/providerBusinessRejection");
const { todoWireToSemantic } = require("../../../modules/memory/infrastructure/providers/output/todoWireProtocol");
const { createRepairFeedback, renderRepairMessage, appendRejectedOutputAttempt, latestRejectedOutput } = require("../../../modules/memory/application/outputRepair");
const { testWriteLimits } = require("../support/memory-builders");
const { writeIssue, rejectWrite, locateWriteError } = require("../../../modules/memory/domain/writeGuards");
const { flatWireToSemanticOutput } = require("../../../modules/memory/infrastructure/providers/output/flatWireProtocol");

const TASK = { proposer: "todoProposer", tickId: 1, targetKey: "todos", targetSections: ["todos"], writeLimits: testWriteLimits() };
const WIRE = { results: { todos: { status: "changes", changes: [
  { action: "complete", target: "T1", sources: ["message:1"] },
  { action: "revise", target: "T9", sources: ["message:2"], text: { mode: "keep" }, actor: { mode: "set", value: "user" }, requester: { mode: "keep" }, due: { mode: "absolute", date: "2026-10-01" } },
] } } };

test("business feedback maps later changes and participant values to Todo wire fields and survives persisted retry", () => {
  const result = { output: todoWireToSemantic(WIRE, TASK), wireOutput: WIRE, protocol: { outputProtocol: "todo", rawSchemaValid: true, schemaHash: "hash" } };
  const mapped = providerBusinessRejection(result, { validationLayer: "business", errors: [{
    code: "TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION", path: "$.sectionResults.todos.changes[1].requester", message: "requester_change_requires_correction",
    meta: { field: "requester", currentValue: "assistant", proposedValue: "user", currentStatus: "overdue", secret: "must-not-leak" },
  }] }, TASK);
  const feedback = createRepairFeedback({ ...mapped, validationLayer: "business" }, 1, TASK);
  assert.equal(feedback.errors[0].path, "$.results.todos.changes[1].requester.value");
  assert.equal(feedback.errors[0].meta.target, "T9");
  assert.deepEqual(feedback.plan.directives, ["RETURN_COMPLETE_REPLACEMENT", "PRESERVE_OR_CORRECT_ORIGINAL_REQUESTER"]);
  const message = renderRepairMessage(feedback, TASK);
  for (const text of ['target="T9"', '原值="assistant"', '候选值="user"', 'keep']) assert.ok(message.includes(text), text);
  assert.doesNotMatch(message, /sectionResults|must-not-leak/);
  const stored = appendRejectedOutputAttempt({}, { ...result, ...mapped }, 0, 2);
  const restored = JSON.parse(JSON.stringify({ stored, feedback }));
  assert.deepEqual(latestRejectedOutput(restored.stored), WIRE);
  assert.equal(restored.stored.schemaRejectedOutputs[0].protocol.schemaHash, "hash");
  assert.equal(renderRepairMessage(restored.feedback, TASK), message);
});

test("source-limit and duplicate rejections produce field-specific corrective instructions", () => {
  const result = { output: todoWireToSemantic(WIRE, TASK), wireOutput: WIRE };
  const mapped = providerBusinessRejection(result, { errors: [
    { code: "SOURCE_LIMIT_EXCEEDED", path: "$.sectionResults.todos.changes[1].evidenceMessageIds", message: "source_limit_exceeded", meta: { limit: 2, actual: 3 } },
    { code: "DUPLICATE_ITEM", path: "$.sectionResults.todos.changes[1].text", message: "duplicate_item" },
  ] }, TASK);
  const feedback = createRepairFeedback(mapped, 1, TASK);
  assert.equal(feedback.errors[0].path, "$.results.todos.changes[1].sources");
  assert.equal(feedback.errors[1].path, "$.results.todos.changes[1].text.value");
  const message = renderRepairMessage(feedback, TASK);
  assert.match(message, /结果包含 3 条底层证据，上限为 2/);
  assert.match(message, /不一定等于 sources 数组长度/);
  assert.match(message, /保留其他合法修改/);
  assert.doesNotMatch(message, /sectionResults|evidenceMessageIds/);
});

test("historical overdue rejection feedback is rendered with current rules without mutating persisted data", () => {
  const feedbackFor = field => createRepairFeedback({ validationLayer: "business", errors: [{
    code: "TODO_OVERDUE_PARTICIPANT_CHANGE", path: `$.results.todos.changes[0].${field}.value`,
    meta: { field, currentValue: "assistant", proposedValue: "user", currentStatus: "overdue" },
  }] }, 1, TASK);
  const message = renderRepairMessage(JSON.parse(JSON.stringify(feedbackFor("requester"))), TASK);
  assert.match(message, /旧版逾期参与者限制/);
  assert.match(message, /revise 保持 requester/);
  assert.match(message, /证据证明原记录错误才用 correct/);
  assert.match(renderRepairMessage(feedbackFor("actor"), TASK), /actor 有明确转交事实时可以 revise/);
  const legacy = { policyVersion: 10, attempt: 2, errors: [{ code: "TODO_OVERDUE_REQUIRES_FUTURE_DUE",
    path: "$.results.todos.changes[0].due", message: "changing an overdue Todo requires a future date" }],
    plan: { directives: ["RESOLVE_OVERDUE_DUE_CONFLICT"] } };
  const before = structuredClone(legacy);
  const rendered = renderRepairMessage(legacy, TASK);
  assert.match(rendered, /该限制已取消/);
  assert.match(rendered, /过去日期改期/);
  assert.doesNotMatch(rendered, /requires a future date|必须严格晚于/);
  assert.deepEqual(legacy, before);
});

test("injected adapters re-encode valid semantic fixtures explicitly and never send malformed IR as Todo", () => {
  const output = todoWireToSemantic(WIRE, TASK);
  const validation = { errors: [{ path: "$.sectionResults.todos.changes[1].dueChange", message: "invalid_state_transition" }] };
  const reencoded = providerBusinessRejection({ output }, validation, TASK);
  assert.deepEqual(reencoded.rejectedOutput, WIRE);
  assert.equal(reencoded.rejectedOutputKind, "semantic_reencoded");
  const malformed = providerBusinessRejection({ output: null }, validation, TASK);
  assert.equal(malformed.rejectedOutput, undefined);
  assert.equal(malformed.rejectedOutputKind, "unavailable");
  const malformedChanges = structuredClone(output);
  malformedChanges.sectionResults.todos.changes = {};
  assert.equal(providerBusinessRejection({ output: malformedChanges }, validation, TASK).rejectedOutputKind, "unavailable");
});

test("new business rules render bounded constraints without registering a special repair template", () => {
  let error;
  try {
    rejectWrite("future_domain_rule", "todos", { field: "actor", constraint: "A supported delegation is required.",
      currentValue: "assistant", proposedValue: "user", rawSource: "private-source", credentials: "secret" });
  } catch (value) { error = locateWriteError(value, "todos", 1); }
  const mapped = providerBusinessRejection({ output: todoWireToSemantic(WIRE, TASK), wireOutput: WIRE }, { errors: error.validationErrors }, TASK);
  const feedback = createRepairFeedback({ ...mapped, validationLayer: "business" }, 1, TASK);
  assert.equal(feedback.errors[0].code, "BUSINESS_RULE_VIOLATION");
  assert.equal(feedback.validationLayer, "business");
  assert.ok(feedback.plan.directives.includes("RECHECK_BUSINESS_CONSTRAINT"));
  const rendered = renderRepairMessage(JSON.parse(JSON.stringify(feedback)), TASK);
  for (const value of ["future_domain_rule", "A supported delegation is required.", "T9", "assistant", "user", "unable_to_decide"]) assert.ok(rendered.includes(value), value);
  assert.doesNotMatch(rendered, /private-source|credentials|secret|sectionResults/);
  const bounded = createRepairFeedback({ errors: [writeIssue("new_rule", "todos", { constraint: "x".repeat(2000), currentValue: false, proposedValue: null })] }, 1, TASK);
  assert.equal(bounded.errors[0].meta.constraint.length, 240);
  assert.equal(bounded.errors[0].meta.currentValue, false);
  assert.equal(bounded.errors[0].meta.proposedValue, null);
});

test("conflict diagnostics map both changes into Todo and interleaved flat wire positions", () => {
  const issue = { code: "CHANGE_TARGET_CONFLICT", path: "$.sectionResults.todos.changes[1]",
    meta: { relatedPath: "$.sectionResults.todos.changes[0]" } };
  const mapped = providerBusinessRejection({ wireOutput: WIRE, output: todoWireToSemantic(WIRE, TASK) }, { errors: [issue] }, TASK);
  const rendered = renderRepairMessage(createRepairFeedback(mapped, 1, TASK), TASK);
  assert.match(rendered, /与 \$\.results\.todos\.changes\[0\] 操作同一目标/);
  assert.doesNotMatch(rendered, /sectionResults|invalid_state_transition/);
  const task = { ...TASK, proposer: "episodeProposer", targetSections: ["recentEpisodes", "milestones"] };
  const wire = { sectionStatuses: { recentEpisodes: "changes", milestones: "changes" }, changes: [
    { section: "milestones", action: "add", text: "纪念日", sources: ["message:1"] },
    { section: "recentEpisodes", action: "append", target: "E1", text: "发展", sources: ["message:2"] },
    { section: "milestones", action: "add", text: "另一纪念日", sources: ["message:1"] },
    { section: "recentEpisodes", action: "forget", target: "E1", sources: ["message:2"] },
  ] };
  const flat = providerBusinessRejection({ wireOutput: wire, output: flatWireToSemanticOutput(wire, task) }, { errors: [{
    ...issue, path: "$.sectionResults.recentEpisodes.changes[1]", meta: { relatedPath: "$.sectionResults.recentEpisodes.changes[0]" },
  }] }, task);
  assert.equal(flat.errors[0].path, "$.changes[3]");
  assert.equal(flat.errors[0].meta.relatedPath, "$.changes[1]");
});

test("unavailable or oversized latest candidates never replay an older rejected output", () => {
  const first = appendRejectedOutputAttempt({}, { rejectedOutput: WIRE }, 0, 3);
  const unavailable = appendRejectedOutputAttempt(first, { rejectedOutputKind: "unavailable" }, 1, 3);
  assert.equal(latestRejectedOutput(unavailable), undefined);
  const oversized = appendRejectedOutputAttempt(first, { rejectedOutput: { specialistOutputs: { data: "x".repeat(300000) } } }, 1, 3);
  assert.equal(latestRejectedOutput(oversized), undefined);
  assert.equal(oversized.schemaRejectedOutputs[1].reason, "size_limit");
});
