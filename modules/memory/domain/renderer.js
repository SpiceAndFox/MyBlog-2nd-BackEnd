const { buildEffectiveMemoryView } = require("./lifecycle");
const { codePointLength } = require("./capacity");

function healthStatus(targetStatuses, targetKey) {
  if (Array.isArray(targetStatuses)) {
    const row = targetStatuses.find((entry) => (entry.targetKey ?? entry.target_key) === targetKey);
    if ((row?.rebuildBoundaryMessageId ?? row?.rebuild_boundary_message_id) !== null && (row?.rebuildBoundaryMessageId ?? row?.rebuild_boundary_message_id) !== undefined) return "rebuilding";
    return row?.status || "healthy";
  }
  return targetStatuses?.[targetKey]?.status || targetStatuses?.[targetKey] || "healthy";
}

function hasLagDiagnostic(diagnostics, targetKey) {
  const lagTypes = new Set(["gap_bridge_omitted", "scene_capacity_exceeded"]);
  return diagnostics.some((entry) => (
    (entry.subjectKind ?? entry.subject_kind) === "target"
    && (entry.subjectKey ?? entry.subject_key) === targetKey
    && lagTypes.has(entry.diagnosticType ?? entry.diagnostic_type)
    && entry.resolved !== true
  ));
}

function renderTargetHealthMarker(targetKey, targetStatuses = {}, diagnostics = []) {
  const status = healthStatus(targetStatuses, targetKey);
  if (status === "rebuilding") return "[该类记忆正在重建]";
  if (["retry_wait", "capacity_blocked", "halted"].includes(status) || hasLagDiagnostic(diagnostics, targetKey)) return "[该类记忆可能滞后]";
  return "";
}

function renderItems(items) { return items.length ? items.map((item) => `- ${item.text}`).join("\n") : "(无)"; }
function renderTodo(todo) {
  const deadline = todo.dueAt ? `；期限: ${todo.dueAt}` : "";
  return `- ${todo.text}（执行者: ${todo.actor}；提出者: ${todo.requester}${deadline}）`;
}
function renderScene(scene) {
  return [
    `- 地点: ${scene.location.value || "未知"}`,
    `- 时间: ${scene.time.value || "未知"}`,
    `- 氛围: ${scene.mood.value || "未知"}`,
    `- 备注: ${scene.note.value || ""}`,
  ].join("\n");
}

function renderOverdueTodosWithinBudget(todos, budget) {
  const ordered = todos.filter((todo) => todo.status === "overdue").sort((left, right) => {
    const timeOrder = new Date(right.becameOverdueAt).getTime() - new Date(left.becameOverdueAt).getTime();
    return timeOrder || left.id.localeCompare(right.id);
  });
  const rendered = [];
  let chars = 0;
  for (const todo of ordered) {
    if (rendered.length >= budget.maxRenderedItems) break;
    const line = renderTodo(todo);
    if (chars + codePointLength(line) > budget.maxRenderedChars) break;
    rendered.push(line);
    chars += codePointLength(line);
  }
  return rendered.join("\n") || "(无)";
}

function markerLine(target, statuses, diagnostics) {
  const marker = renderTargetHealthMarker(target, statuses, diagnostics);
  return marker ? `${marker}\n` : "";
}

function renderMemory({ state, lifecycleAnchors = {}, requestNow, config, targetStatuses = {}, diagnostics = [] }) {
  const effective = buildEffectiveMemoryView(state, lifecycleAnchors, requestNow, config);
  const view = effective.view;
  const sections = [
    "[长期核心记忆]",
    `${markerLine("worldFacts", targetStatuses, diagnostics)}[长期事实]\n${renderItems(view.longTerm.worldFacts)}`,
    `${markerLine("profileRelationship", targetStatuses, diagnostics)}[User 核心档案]\n${renderItems(view.longTerm.userProfile)}`,
    `[Assistant 核心档案]\n${renderItems(view.longTerm.assistantProfile)}`,
    `[关系模式]\n${renderItems(view.longTerm.relationship)}`,
    `${markerLine("episodes", targetStatuses, diagnostics)}[重要里程碑]\n${renderItems(view.longTerm.milestones)}`,
    `${markerLine("standingAgreements", targetStatuses, diagnostics)}[持续约定]\n${renderItems(view.working.standingAgreements)}`,
    `${markerLine("todos", targetStatuses, diagnostics)}[待办]\n${view.working.todos.filter((todo) => todo.status === "active").map(renderTodo).join("\n") || "(无)"}`,
    `[已逾期待办]\n${renderOverdueTodosWithinBudget(view.working.todos, config.overdueTodos)}`,
    `${markerLine("episodes", targetStatuses, diagnostics)}[最近经历]\n${renderItems(view.working.recentEpisodes)}`,
    `${markerLine("scene", targetStatuses, diagnostics)}[当前状态]\n${renderScene(view.current.scene)}`,
    `[已过期场景 / 上次已知场景]\n${view.current.previousScene ? renderScene(view.current.previousScene) : "(无)"}`,
  ];
  return {
    renderedText: sections.join("\n\n"),
    needsHousekeeping: effective.needsHousekeeping,
    cleanupEvents: effective.cleanupEvents,
    effectiveView: view,
  };
}

module.exports = { renderMemory, renderTargetHealthMarker, renderTodo, renderScene, renderOverdueTodosWithinBudget };
