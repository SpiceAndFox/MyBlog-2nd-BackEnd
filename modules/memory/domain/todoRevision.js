const { isDeepStrictEqual } = require("node:util");
const { normalizeSourceRefs } = require("../contracts");
const { itemLimitIssues, writeIssue, rejectWriteIssues } = require("./writeGuards");
const { VALIDATION_ISSUE_CODES: ISSUE_CODES } = require("../contracts/validationIssueCodes");
const { classifyTodoDeadline } = require("./lifecycle");

const sameDate = (left, right) => left === right
  || (left !== null && right !== null && new Date(left).getTime() === new Date(right).getTime());

function applyTodoRevision(item, patch, nowMs, task) {
  const { value } = patch;
  const next = {
    text: value.text ?? item.text,
    actor: value.actor ?? item.actor,
    requester: value.requester ?? item.requester,
    dueAt: value.dueChange.mode === "keep" ? item.dueAt
      : value.dueChange.mode === "clear" ? null : value.dueChange.dueAt,
  };
  const sourceRefs = normalizeSourceRefs(patch.sourceRefs);
  // A redundant proposal must still satisfy the current limits and contract.
  const issues = itemLimitIssues("todos", next.text, sourceRefs, task);
  const sameFields = next.text === item.text && next.actor === item.actor
    && next.requester === item.requester && sameDate(next.dueAt, item.dueAt);
  if (patch.op !== "correctItem" && next.requester !== item.requester) {
    issues.push(writeIssue("requester_change_requires_correction", "todos", {
      issueCode: ISSUE_CODES.TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION, field: "requester",
      currentValue: item.requester, proposedValue: next.requester,
      constraint: "requester identifies the original initiator; only a supported correction may change it",
    }));
  }
  // Report independent failures together, before changing any state.
  rejectWriteIssues(issues);
  if (sameFields) {
    if (isDeepStrictEqual(sourceRefs, normalizeSourceRefs(item.sourceRefs))) return { noop: true };
    // Evidence replacement is not a request to reactivate an overdue Todo.
    item.sourceRefs = sourceRefs;
    item.updatedAtMessageId = task.targetMessageId;
    return { evidenceOnly: true };
  }
  // The accepted operation records the complete classified post-state. A date
  // correction or deadline removal must not masquerade as a new commitment.
  Object.assign(item, next, classifyTodoDeadline(next.dueAt, nowMs), {
    sourceRefs, updatedAtMessageId: task.targetMessageId,
  });
  return {};
}

module.exports = { applyTodoRevision };
