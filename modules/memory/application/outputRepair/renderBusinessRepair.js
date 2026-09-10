const { ISSUE_CODES } = require("./policy");

const quoted = value => JSON.stringify(value ?? null).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

// One entry owns the code's description, planned directive and actual advice.
// New domain constraints still receive generic feedback without a new entry.
const BUSINESS_REPAIR_RULES = Object.freeze({
  [ISSUE_CODES.TODO_OVERDUE_REQUIRES_FUTURE_DUE]: {
    message: "changing an overdue Todo's business fields requires a supported future due date",
    directive: "RESOLVE_OVERDUE_DUE_CONFLICT",
    render: ({ meta, location, todoWire }) => [
        `${location}：目标已经逾期；原截止时刻=${quoted(meta.currentDueAt)}，候选解析后的截止时刻=${quoted(meta.proposedDueAt)}，本次状态判断时间=${quoted(meta.referenceTime)}。修改业务字段并恢复待办时，新的截止时刻必须严格晚于该判断时间。以上是 UTC 截止时刻，不是让你复制到日期字段的值。`,
        todoWire
          ? '核对 due 的模式、数值和日期来源消息；只能依据原始消息改期，不得为了通过校验编造未来日期或用本次判断时间重新解释历史消息。若只补充证据，text、actor、requester 使用 keep，due 使用 {"mode":"keep"}，仅更新 sources；其他业务字段确实需要修改时，不能用 keep 掩盖该修改。'
          : "核对日期模式、数值和日期来源消息；只能依据原始消息改期，不得为了通过校验编造未来日期或用本次判断时间重新解释历史消息。若只补充证据，保留所有业务字段和原期限，仅更新来源。",
        "无法合法裁决时使用 unable_to_decide；确认只是重复表达且没有变化时才使用 noop。不得伪造 complete、cancel、forget 等动作绕过冲突。",
    ],
  },
  [ISSUE_CODES.TODO_OVERDUE_PARTICIPANT_CHANGE]: {
    message: "reactivating an overdue Todo must preserve actor and requester",
    directive: "PRESERVE_OVERDUE_PARTICIPANTS",
    render: ({ meta, location, todoWire }) => [
      `${location}：恢复逾期待办时不能同时更换 ${meta.field === "requester" ? "requester" : "actor"}；原值=${quoted(meta.currentValue)}，候选值=${quoted(meta.proposedValue)}。${todoWire ? '该字段使用 {"mode":"keep"} 保留原值。' : "保留该字段原值。"}若原始消息确实要求更换责任归属，不能假装没有这项变化，也不能虚构新任务或终止动作；无法裁决时使用 unable_to_decide。`,
      ...(meta.field === "requester" ? ["核对这项行动最初由谁提出。后续接受、催促、质疑或再次确认不会改变 requester；确认旧值正确时保留它。只有证据证明原记录错误才考虑 correct，更正仍须满足当前状态约束。"] : []),
    ],
  },
  [ISSUE_CODES.SOURCE_LIMIT_EXCEEDED]: {
    message: "resolved evidence must satisfy the section source limit",
    directive: "SELECT_SUFFICIENT_SOURCES_WITHIN_LIMIT",
    render: ({ meta, location }) => [
      `${location}：结果包含 ${meta.actual ?? "过多"} 条底层证据，上限为 ${meta.limit ?? "task.writeLimits 中的值"}。memory 来源可能展开为多条证据，append 还会保留旧证据；这不一定等于 sources 数组长度。重新选择足以支持完整结果的最少来源；不能通过丢失必要证据或编造来源满足限制，证据不足时使用 unable_to_decide。`,
    ],
  },
  [ISSUE_CODES.DUPLICATE_ITEM]: {
    message: "text duplicates another existing item",
    directive: "RESOLVE_EXISTING_ITEM_DUPLICATE",
    render: ({ location }) => [
      `${location}：文本与另一已有条目重复。检查可见 Memory 中的现有事项；确认无新增事实时删除这条冗余 change，保留其他合法修改；确有发展时选择正确的可见 target，不要仅换一种措辞制造重复条目。没有剩余变化才使用 noop。`,
    ],
  },
  [ISSUE_CODES.CHANGE_TARGET_CONFLICT]: {
    message: "multiple changes in this candidate address the same writable target",
    directive: "RESOLVE_TARGET_CHANGE_CONFLICT",
    render: ({ meta, location }) => [
      `${location}：与 ${meta.relatedPath || "同一候选中的另一条 change"} 操作同一目标。请根据原始消息裁决为该目标的一条合法 change，保留其他目标的合法修改；不能靠交换顺序、换 target 或虚构终止动作绕过冲突。无法裁决时使用 unable_to_decide；确实没有变化时才使用 noop。`,
    ],
  },
});

function businessRepairRule(code) { return BUSINESS_REPAIR_RULES[code]; }

function renderBusinessRepair(issues, { todoWire = false } = {}) {
  return issues.flatMap(issue => {
    const meta = issue.meta || {};
    const location = `${issue.path}${meta.target ? `（target=${quoted(meta.target)}）` : ""}`;
    const rule = businessRepairRule(issue.code);
    if (rule) return rule.render({ meta, location, todoWire });
    if (issue.code !== ISSUE_CODES.BUSINESS_RULE_VIOLATION && !meta.constraint) return [];
    const context = ["currentValue", "proposedValue", "limit", "actual"]
      .filter(key => Object.hasOwn(meta, key)).map(key => `${key}=${quoted(meta[key])}`).join("，");
    return [
      `${location}：业务规则 ${quoted(meta.reason || issue.code)} 未满足。约束：${quoted(meta.constraint || issue.message)}。${context ? `上下文：${context}。` : ""}依据原始消息和当前 Memory 重新判断，保留其他合法修改；不得编造事实、来源或动作来通过校验。没有足够信息确定合法修改时使用 unable_to_decide；确认没有变化时才使用 noop。`,
    ];
  });
}

module.exports = { businessRepairRule, renderBusinessRepair };
