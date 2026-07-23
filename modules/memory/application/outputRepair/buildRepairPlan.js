const { classifyIssues } = require("./classifyIssues");
const { ISSUE_CODES, OUTPUT_REPAIR_POLICY_VERSION } = require("./policy");

function expectedShape(task) {
  const sections = Array.isArray(task?.targetSections) ? task.targetSections : [];
  return {
    tickId: "<copy task.tickId>",
    proposer: task?.proposer || "<copy task.proposer>",
    sectionResults: Object.fromEntries(sections.map((section) => [section, "<complete section result>"])),
  };
}

function buildRepairPlan({ errors, specialist = null, task = null } = {}) {
  const issues = classifyIssues(errors);
  const codes = [...new Set(issues.map((issue) => issue.code))];
  const directives = ["RETURN_COMPLETE_REPLACEMENT"];
  if (codes.some((code) => [ISSUE_CODES.OBJECT_REQUIRED, ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT].includes(code))) {
    directives.push("MATCH_EXACT_ROOT_SHAPE");
  }
  if (codes.some((code) => [
    ISSUE_CODES.WRITABLE_REF_INVALID,
    ISSUE_CODES.SUPPORT_REF_INVALID,
    ISSUE_CODES.EVIDENCE_MESSAGE_INVALID,
  ].includes(code))) directives.push("SELECT_ONLY_SCHEMA_ENUM_SOURCES");
  if (codes.includes(ISSUE_CODES.SOURCE_MISSING)) directives.push("SUPPLY_ONE_VISIBLE_SOURCE_OR_REMOVE_CHANGE");
  if (codes.includes(ISSUE_CODES.TEXT_LENGTH_EXCEEDED)) directives.push("REWRITE_ATOMIC_TEXT_WITHIN_LIMIT");
  if (codes.includes(ISSUE_CODES.CHANGES_EMPTY)) directives.push("USE_NOOP_FOR_ZERO_CHANGES");
  return {
    policyVersion: OUTPUT_REPAIR_POLICY_VERSION,
    retryScope: specialist ? { kind: "specialist", proposer: specialist } : { kind: "task" },
    issueCodes: codes,
    directives,
    expectedShape: expectedShape(task),
  };
}

module.exports = { buildRepairPlan, expectedShape };
