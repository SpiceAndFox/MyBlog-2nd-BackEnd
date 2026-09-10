const { ISSUE_CODES } = require("./policy");

const quoted = value => JSON.stringify(value ?? null).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

function renderBusinessRepair(issues, { todoV2 = false } = {}) {
  return issues.flatMap(issue => {
    const meta = issue.meta || {};
    const location = `${issue.path}${meta.target ? `（target=${quoted(meta.target)}）` : ""}`;
    if (issue.code === ISSUE_CODES.TODO_OVERDUE_REQUIRES_FUTURE_DUE) {
      return [
        `${location}：目标已经逾期；原截止时刻=${quoted(meta.currentDueAt)}，候选解析后的截止时刻=${quoted(meta.proposedDueAt)}，本次状态判断时间=${quoted(meta.referenceTime)}。修改业务字段并恢复待办时，新的截止时刻必须严格晚于该判断时间。以上是 UTC 截止时刻，不是让你复制到日期字段的值。`,
        todoV2
          ? '核对 due 的模式、数值和日期来源消息；只能依据原始消息改期，不得为了通过校验编造未来日期或用本次判断时间重新解释历史消息。若只补充证据，text、actor、requester 使用 keep，due 使用 {"mode":"keep"}，仅更新 sources；其他业务字段确实需要修改时，不能用 keep 掩盖该修改。'
          : "核对日期模式、数值和日期来源消息；只能依据原始消息改期，不得为了通过校验编造未来日期或用本次判断时间重新解释历史消息。若只补充证据，保留所有业务字段和原期限，仅更新来源。",
        "无法合法裁决时使用 unable_to_decide；确认只是重复表达且没有变化时才使用 noop。不得伪造 complete、cancel、forget 等动作绕过冲突。",
      ];
    }
    if (issue.code === ISSUE_CODES.TODO_OVERDUE_PARTICIPANT_CHANGE) return [
      `${location}：恢复逾期待办时不能同时更换 ${meta.field === "requester" ? "requester" : "actor"}；原值=${quoted(meta.currentValue)}，候选值=${quoted(meta.proposedValue)}。${todoV2 ? '该字段使用 {"mode":"keep"} 保留原值。' : "保留该字段原值。"}若原始消息确实要求更换责任归属，不能假装没有这项变化，也不能虚构新任务或终止动作；无法裁决时使用 unable_to_decide。`,
    ];
    if (issue.code === ISSUE_CODES.SOURCE_LIMIT_EXCEEDED) return [
      `${location}：本次选择了 ${meta.actual ?? "过多"} 条来源，上限为 ${meta.limit ?? "task.writeLimits 中的值"}。重新选择足以支持完整结果的最少来源；不能通过丢失必要证据或编造来源满足限制，证据不足时使用 unable_to_decide。`,
    ];
    if (issue.code === ISSUE_CODES.DUPLICATE_ITEM) return [
      `${location}：文本与另一已有条目重复。检查可见 Memory 中的现有事项；确认无新增事实时删除这条冗余 change，保留其他合法修改；确有发展时选择正确的可见 target，不要仅换一种措辞制造重复条目。没有剩余变化才使用 noop。`,
    ];
    return [];
  });
}

module.exports = { renderBusinessRepair };
