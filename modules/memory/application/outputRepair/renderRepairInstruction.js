const { buildRepairPlan } = require("./buildRepairPlan");
const { classifyIssues } = require("./classifyIssues");
const { ISSUE_CODES } = require("./policy");

function lengthLimits(issues) {
  return [...new Set(issues
    .filter((issue) => issue.code === ISSUE_CODES.TEXT_LENGTH_EXCEEDED)
    .map((issue) => Number(issue.meta?.limit))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function renderRepairInstruction(systemPrompt, feedback = {}, task = null) {
  const safeFeedback = feedback && typeof feedback === "object" ? feedback : {};
  const issues = classifyIssues(safeFeedback.errors);
  if (!issues.length) return systemPrompt;
  // Rebuild from the actual invocation task. A durable composite Profile
  // failure is retried as one specialist whose proposer/sections differ from
  // the original task, so its output skeleton must be specialist-shaped.
  const plan = buildRepairPlan({
    errors: issues,
    specialist: safeFeedback.specialist,
    task,
  });
  const targets = [];
  if (plan.directives.includes("MATCH_EXACT_ROOT_SHAPE")) {
    targets.push(`完整根结构必须匹配：${JSON.stringify(plan.expectedShape)}`);
  }
  if (plan.directives.includes("SELECT_ONLY_SCHEMA_ENUM_SOURCES")) {
    targets.push("ref、supportRefs 与 evidenceMessageIds 只从本次 tool schema 的 enum 值中选择。");
  }
  if (plan.directives.includes("SUPPLY_ONE_VISIBLE_SOURCE_OR_REMOVE_CHANGE")) {
    targets.push("每个 change 至少提供一种 schema 允许的可见来源；没有来源的候选不输出，并重新给出该 section 的终局。");
  }
  if (plan.directives.includes("REWRITE_ATOMIC_TEXT_WITHIN_LIMIT")) {
    const limits = lengthLimits(issues);
    targets.push(`将超长字段改写为一个原子短句，Unicode 字符数不得超过 ${limits.length ? limits.join("/") : "错误中给定的"} 上限。`);
  }
  if (plan.directives.includes("USE_NOOP_FOR_ZERO_CHANGES")) {
    targets.push("没有 change 时返回 status=noop。");
  }
  const diagnostics = issues.map((issue, index) => (
    `${index + 1}. [${issue.code}] ${issue.path}: ${issue.message}`
  ));
  return `${systemPrompt}\n\n[SCHEMA_REPAIR_V${plan.policyVersion}]\n请重新生成一份完整的 tool arguments；事实判断仍完全依据原始 Memory task。\n${targets.map((line) => `- ${line}`).join("\n")}\n校验定位：\n${diagnostics.join("\n")}`;
}

module.exports = { renderRepairInstruction };
