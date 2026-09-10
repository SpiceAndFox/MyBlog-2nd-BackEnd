const { isDeepStrictEqual } = require("node:util");
const { normalizeSourceRefs } = require("../contracts");
const { itemLimitIssues, writeIssue, rejectWriteIssues } = require("./writeGuards");
const { VALIDATION_ISSUE_CODES: ISSUE_CODES } = require("../contracts/validationIssueCodes");

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
  const wasOverdue = item.status === "overdue";
  if (wasOverdue && !sameFields) {
    const dates = { currentStatus: item.status, currentDueAt: item.dueAt,
      proposedDueAt: next.dueAt, referenceTime: new Date(nowMs).toISOString() };
    if (value.dueChange.mode !== "set" || new Date(next.dueAt).getTime() <= nowMs) {
      issues.push(writeIssue("invalid_state_transition", "todos", {
        ...dates, issueCode: ISSUE_CODES.TODO_OVERDUE_REQUIRES_FUTURE_DUE, field: "dueChange",
      }));
    }
    for (const field of ["actor", "requester"]) {
      if (next[field] !== item[field]) issues.push(writeIssue("invalid_state_transition", "todos", {
        ...dates, issueCode: ISSUE_CODES.TODO_OVERDUE_PARTICIPANT_CHANGE, field,
        currentValue: item[field], proposedValue: next[field],
      }));
    }
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
  if (wasOverdue) {
    item.status = "active";
    item.becameOverdueAt = null;
  }
  Object.assign(item, next, { sourceRefs, updatedAtMessageId: task.targetMessageId });
  return { revived: wasOverdue };
}

module.exports = { applyTodoRevision };
