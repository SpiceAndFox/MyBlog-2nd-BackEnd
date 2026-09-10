const { classifyIssues } = require("./classifyIssues");
const { ISSUE_CODES, OUTPUT_REPAIR_POLICY_VERSION } = require("./policy");
const { LIBRARIAN_PROPOSER } = require("../../contracts");
const { isFlatWireProposer } = require("../../contracts/flatWire");
const { usesTodoWireProtocol } = require("../../contracts/outputProtocol");
const { businessRepairRule } = require("./renderBusinessRepair");

function expectedShape(task) {
  if (usesTodoWireProtocol(task)) return { results: { todos: { status: "<noop | unable_to_decide | changes>", changes: "<only present for changes; complete Todo array>" } } };
  if (task?.proposer === LIBRARIAN_PROPOSER) {
    return {
      tickId: "<copy task.tickId>",
      proposer: LIBRARIAN_PROPOSER,
      status: "noop | changes",
      operations: "<empty for noop; complete operation array for changes>",
    };
  }
  const sections = Array.isArray(task?.targetSections) ? task.targetSections : [];
  if (isFlatWireProposer(task?.proposer)) {
    return {
      sectionStatuses: Object.fromEntries(sections.map((section) => [
        section,
        "<changes | noop | unable_to_decide>",
      ])),
      changes: "<complete flat change array; [] when all sections are noop or unable_to_decide>",
    };
  }
  return {
    tickId: "<copy task.tickId>",
    proposer: task?.proposer || "<copy task.proposer>",
    sectionResults: Object.fromEntries(sections.map((section) => [section, "<complete section result>"])),
  };
}

function buildRepairPlan({ errors, specialist = null, task = null } = {}) {
  const issues = classifyIssues(errors, { usesFlatWire: isFlatWireProposer(task?.proposer), usesTodoWireProtocol: usesTodoWireProtocol(task) });
  const codes = [...new Set(issues.map((issue) => issue.code))];
  const directives = ["RETURN_COMPLETE_REPLACEMENT"];
  if (codes.includes(ISSUE_CODES.TOOL_ARGUMENTS_INVALID_JSON)) {
    directives.push("RETURN_VALID_JSON_TOOL_ARGUMENTS");
  }
  if (codes.includes(ISSUE_CODES.STRUCTURED_OUTPUT_INCOMPLETE)) {
    directives.push("RETURN_SHORT_COMPLETE_OUTPUT");
  }
  if (codes.includes(ISSUE_CODES.STRUCTURED_OUTPUT_MISSING)) {
    directives.push("RETURN_REQUIRED_STRUCTURED_OUTPUT");
  }
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
  for (const code of codes) {
    const rule = businessRepairRule(code);
    if (rule) directives.push(rule.directive);
  }
  if (issues.some(issue => !businessRepairRule(issue.code)
    && (issue.code === ISSUE_CODES.BUSINESS_RULE_VIOLATION || issue.meta?.constraint))) directives.push("RECHECK_BUSINESS_CONSTRAINT");
  if (codes.includes(ISSUE_CODES.CHANGES_EMPTY)) directives.push("USE_NOOP_FOR_ZERO_CHANGES");
  const specialists = [...new Set(issues.map(issue => issue.meta?.specialist).filter(Boolean))];
  return {
    policyVersion: OUTPUT_REPAIR_POLICY_VERSION,
    retryScope: specialist ? { kind: "specialist", proposer: specialist }
      : specialists.length ? { kind: "specialists", proposers: specialists } : { kind: "task" },
    issueCodes: codes,
    directives,
    expectedShape: expectedShape(task),
  };
}

module.exports = { buildRepairPlan, expectedShape };
