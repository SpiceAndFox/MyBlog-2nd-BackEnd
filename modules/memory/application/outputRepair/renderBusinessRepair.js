const { ISSUE_CODES } = require("./policy");

const quoted = value => JSON.stringify(value ?? null).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

// One entry owns the code's description, planned directive and actual advice.
// New domain constraints still receive generic feedback without a new entry.
const BUSINESS_REPAIR_RULES = Object.freeze({
  [ISSUE_CODES.TODO_OVERDUE_REQUIRES_FUTURE_DUE]: {
    // Historical tasks may retain these codes. Re-render using today's rules
    // without rewriting their diagnostics or resetting their retry allowance.
    message: "legacy overdue edit restriction has been superseded; recheck the supported facts",
    directive: "RECHECK_TODO_FACTS",
    render: ({ location }) => [
      `${location}：这是旧版逾期编辑规则的拒绝记录，该限制已取消。允许有证据的文本修改、过去日期改期与日期更正；系统按修改后的期限计算 active/overdue，修改不代表重新承诺。`,
      "期限没有变化时使用 keep；只有明确取消期限且事项仍成立才使用 clear。不得编造未来日期，不得用处理时间重新解释历史消息。依据当前输入重新给出完整结果，不必修改原本有证据支持的合法字段。",
    ],
  },
  [ISSUE_CODES.TODO_OVERDUE_PARTICIPANT_CHANGE]: {
    message: "legacy overdue participant restriction has been superseded; apply field-specific rules",
    directive: "RECHECK_TODO_FACTS",
    render: ({ location }) => [
      `${location}：这是旧版逾期参与者限制的拒绝记录。actor 有明确转交事实时可以 revise，录错时可以 correct；是否逾期不限制有证据的修改。`,
      "requester 表示最初提出方；revise 保持 requester，只有证据证明原记录错误才用 correct 更正。不得为通过校验虚构转交、更正或新事项。",
    ],
  },
  [ISSUE_CODES.TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION]: {
    message: "revise must preserve the original requester; only an evidenced correction may change it",
    directive: "PRESERVE_OR_CORRECT_ORIGINAL_REQUESTER",
    render: ({ meta, location }) => [
      `${location}：requester 是最初提出方，原值=${quoted(meta.currentValue)}，候选值=${quoted(meta.proposedValue)}。后续接受、催促、再次确认或转交执行者不会改变 requester；普通 revise 使用 keep 保留原值。`,
      "只有可见证据证明原记录从一开始就错误时才使用 correct 并更正 requester；不得仅为绕过校验把 revise 改名为 correct。证据不足时使用 unable_to_decide；其他有证据的修改仍应保留。",
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
