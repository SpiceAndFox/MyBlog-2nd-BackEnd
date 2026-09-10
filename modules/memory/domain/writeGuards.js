const { sectionLimits, codePointLength } = require("../contracts/sectionPolicy");
const { VALIDATION_ISSUE_CODES: CODES, MAX_VALIDATION_ISSUES } = require("../contracts/validationIssueCodes");

const WRITE_RULES = {
  text_length_exceeded: { code: CODES.TEXT_LENGTH_EXCEEDED, field: "text" },
  append_length_exceeded: { code: CODES.TEXT_LENGTH_EXCEEDED, field: "text" },
  source_limit_exceeded: { code: CODES.SOURCE_LIMIT_EXCEEDED, field: "evidenceMessageIds" },
  duplicate_item: { code: CODES.DUPLICATE_ITEM, field: "text" },
  item_not_found: { code: CODES.WRITABLE_REF_INVALID, field: "ref" },
  action_not_allowed: { constraint: "The action must be supported by the target section." },
  merge_evidence_not_authorized: { constraint: "Merge evidence must come from the items being merged." },
  capacity_exceeded: { constraint: "The resulting section must fit its rendered character budget." },
  invalid_state_transition: { constraint: "The action must be compatible with the target's current state." },
};

// Domain-owned diagnostics contain facts and constraints, never a guessed repair.
function writeIssue(reason, section, detail = {}) {
  const rule = WRITE_RULES[reason] || {};
  const { issueCode, ...meta } = detail;
  return {
    code: issueCode || rule.code || CODES.BUSINESS_RULE_VIOLATION,
    path: `$.sectionResults.${section}`,
    message: `${reason}${detail.limit === undefined ? "" : ` (limit=${detail.limit}, actual=${detail.actual})`}`,
    meta: { section, reason, ...(rule.field ? { field: rule.field } : {}),
      ...(rule.constraint ? { constraint: rule.constraint } : {}), ...meta },
  };
}

function rejectWriteIssues(issues) {
  if (!issues.length) return;
  const reason = issues[0].meta?.reason || "business_rule_violation";
  const error = new Error(`Memory write rejected: ${reason}`);
  error.code = "MEMORY_WRITE_GUARD_INVALID";
  error.reason = reason;
  error.validationErrors = issues.slice(0, MAX_VALIDATION_ISSUES);
  throw error;
}

function rejectWrite(reason, section, detail = {}) {
  rejectWriteIssues([writeIssue(reason, section, detail)]);
}

function locateWriteError(error, section, changeIndex) {
  if (error?.code !== "MEMORY_WRITE_GUARD_INVALID") return error;
  error.validationErrors = error.validationErrors.map(issue => ({ ...issue,
    path: `$.sectionResults.${section}.changes[${changeIndex}]${issue.meta?.field ? `.${issue.meta.field}` : ""}`,
  }));
  return error;
}

function itemLimitIssues(section, text, sourceRefs, task) {
  const limits = sectionLimits(section, task);
  const chars = codePointLength(text);
  const issues = [];
  if (chars > limits.maxItemChars) issues.push(writeIssue("text_length_exceeded", section, { limit: limits.maxItemChars, actual: chars }));
  if (limits.maxSourceRefs !== null && sourceRefs.length > limits.maxSourceRefs) issues.push(writeIssue("source_limit_exceeded", section, { limit: limits.maxSourceRefs, actual: sourceRefs.length }));
  return issues;
}

function assertItemLimits(section, text, sourceRefs, task) {
  rejectWriteIssues(itemLimitIssues(section, text, sourceRefs, task));
}

module.exports = { writeIssue, rejectWriteIssues, rejectWrite, itemLimitIssues, assertItemLimits, locateWriteError };
