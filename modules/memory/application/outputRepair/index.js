const { buildRepairPlan, expectedShape } = require("./buildRepairPlan");
const { classifyIssues, inferIssueCode, summarizeOutputShape, valueType } = require("./classifyIssues");
const { normalizeSemanticOutput } = require("./normalizeOutput");
const { ISSUE_CODES, OUTPUT_REPAIR_POLICY_VERSION, SAFE_NORMALIZATIONS } = require("./policy");
const { renderRepairInstruction } = require("./renderRepairInstruction");

function createRepairFeedback(detail = {}, attempt = 0, task = null) {
  const errors = classifyIssues(detail.errors);
  if (!errors.length) {
    errors.push({
      code: ISSUE_CODES.CONTRACT_INVALID,
      path: "$",
      message: "does not satisfy the local output contract",
    });
  }
  const specialist = typeof detail.specialist === "string" && detail.specialist ? detail.specialist : null;
  return {
    policyVersion: OUTPUT_REPAIR_POLICY_VERSION,
    attempt,
    ...(specialist ? { specialist } : {}),
    errors,
    plan: buildRepairPlan({ errors, specialist, task }),
  };
}

module.exports = {
  ISSUE_CODES,
  OUTPUT_REPAIR_POLICY_VERSION,
  SAFE_NORMALIZATIONS,
  buildRepairPlan,
  classifyIssues,
  createRepairFeedback,
  expectedShape,
  inferIssueCode,
  normalizeSemanticOutput,
  renderRepairInstruction,
  summarizeOutputShape,
  valueType,
};
