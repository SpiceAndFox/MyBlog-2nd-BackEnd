"use strict";

const state = {
  scope: null,
  generation: null,
  tasks: [],
  filtered: [],
  selectedTaskId: null,
  activeView: "overview",
  preferredGeneration: null,
};

const elements = {
  form: document.querySelector("#scope-form"),
  userId: document.querySelector("#user-id"),
  presetId: document.querySelector("#preset-id"),
  generation: document.querySelector("#generation"),
  loadButton: document.querySelector("#load-button"),
  refreshButton: document.querySelector("#refresh-button"),
  notice: document.querySelector("#notice"),
  stats: document.querySelector("#stats"),
  taskCount: document.querySelector("#task-count"),
  taskList: document.querySelector("#task-list"),
  detail: document.querySelector("#detail"),
  search: document.querySelector("#search"),
  targetFilter: document.querySelector("#target-filter"),
  statusFilter: document.querySelector("#status-filter"),
  codeTemplate: document.querySelector("#code-panel-template"),
};

function apiUrl(pathname, params) {
  const url = new URL(pathname, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setBusy(busy, message) {
  elements.loadButton.disabled = busy;
  elements.refreshButton.disabled = busy || !state.scope;
  if (message) {
    elements.notice.classList.remove("error");
    elements.notice.textContent = message;
  }
}

function showError(error) {
  elements.notice.classList.add("error");
  elements.notice.textContent = error?.message || String(error);
}

function persistScope() {
  localStorage.setItem("memory-task-gui-scope", JSON.stringify({
    userId: elements.userId.value,
    presetId: elements.presetId.value,
    generation: elements.generation.value,
  }));
}

function restoreScope() {
  try {
    const saved = JSON.parse(localStorage.getItem("memory-task-gui-scope"));
    if (saved?.userId) elements.userId.value = saved.userId;
    if (saved?.presetId) elements.presetId.value = saved.presetId;
    if (saved?.generation) state.preferredGeneration = String(saved.generation);
  } catch {}
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

async function loadGenerations({ preserveGeneration = true } = {}) {
  const scope = {
    userId: elements.userId.value,
    presetId: elements.presetId.value.trim(),
  };
  const previous = preserveGeneration ? (elements.generation.value || state.preferredGeneration) : null;
  const data = await fetchJson(apiUrl("/api/generations", scope));
  state.scope = data.scope;
  elements.generation.replaceChildren();
  if (!data.generations.length) {
    elements.generation.append(option("", "没有 proposer task"));
    elements.generation.disabled = true;
    return null;
  }
  const total = data.generations.reduce((sum, item) => sum + item.taskCount, 0);
  elements.generation.append(option("all", `全部 generations · ${total} tasks`));
  for (const generation of data.generations) {
    const attention = Object.entries(generation.statuses)
      .filter(([status]) => status !== "succeeded" && status !== "cancelled")
      .reduce((sum, [, count]) => sum + count, 0);
    const suffix = attention ? ` · ${attention} attention` : "";
    elements.generation.append(option(String(generation.sourceGeneration), `Generation ${generation.sourceGeneration} · ${generation.taskCount} tasks${suffix}`));
  }
  elements.generation.disabled = false;
  const available = [...elements.generation.options].some((item) => item.value === previous);
  elements.generation.value = available && previous ? previous : String(data.generations[0].sourceGeneration);
  state.preferredGeneration = null;
  return elements.generation.value;
}

async function loadTasks({ reloadGenerations = true } = {}) {
  setBusy(true, "正在读取持久化任务…");
  try {
    if (reloadGenerations) await loadGenerations();
    if (!state.scope || elements.generation.disabled) {
      state.tasks = [];
      state.filtered = [];
      renderAll();
      setBusy(false, "该 scope 没有 proposer task。");
      return;
    }
    const generation = elements.generation.value || "all";
    const data = await fetchJson(apiUrl("/api/tasks", { ...state.scope, generation }));
    state.generation = generation;
    state.tasks = data.tasks;
    if (!state.tasks.some((task) => task.taskId === state.selectedTaskId)) state.selectedTaskId = state.tasks[0]?.taskId || null;
    persistScope();
    populateFilters();
    applyFilters();
    setBusy(false, `已读取 ${data.taskCount} 个任务 · 持久化 task / ops · 只读`);
  } catch (error) {
    setBusy(false);
    showError(error);
  }
}

function populateFilters() {
  const currentTarget = elements.targetFilter.value;
  const currentStatus = elements.statusFilter.value;
  const targets = [...new Set(state.tasks.map((task) => task.targetKey).filter(Boolean))].sort();
  const statuses = [...new Set(state.tasks.map((task) => task.status).filter(Boolean))].sort();
  elements.targetFilter.replaceChildren(option("", "全部 target"), ...targets.map((value) => option(value, value)));
  elements.statusFilter.replaceChildren(option("", "全部状态"), ...statuses.map((value) => option(value, value)));
  if (targets.includes(currentTarget)) elements.targetFilter.value = currentTarget;
  if (statuses.includes(currentStatus)) elements.statusFilter.value = currentStatus;
}

function applyFilters() {
  const query = elements.search.value.trim().toLowerCase();
  const target = elements.targetFilter.value;
  const status = elements.statusFilter.value;
  state.filtered = state.tasks.filter((task) => {
    if (target && task.targetKey !== target) return false;
    if (status && task.status !== status) return false;
    if (!query) return true;
    return [task.taskId, task.proposer, task.targetKey, task.stage, task.lastErrorReason]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
  if (!state.filtered.some((task) => task.taskId === state.selectedTaskId)) state.selectedTaskId = state.filtered[0]?.taskId || null;
  renderAll();
}

function badge(value) {
  const node = document.createElement("span");
  node.className = `badge ${String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_")}`;
  node.textContent = value ?? "—";
  return node;
}

function renderStats() {
  const tasks = state.tasks;
  const attention = tasks.filter((task) => !["succeeded", "cancelled"].includes(task.status)).length;
  const retried = tasks.filter((task) => Number(task.attempt) > 0 || Number(task.contextExpansionAttempt) > 0).length;
  const values = [
    ["Tasks", tasks.length],
    ["Succeeded", tasks.filter((task) => task.status === "succeeded").length],
    ["Needs attention", attention, attention ? "attention" : ""],
    ["Retried / expanded", retried, retried ? "attention" : ""],
    ["Targets", new Set(tasks.map((task) => task.targetKey).filter(Boolean)).size],
  ];
  elements.stats.replaceChildren(...values.map(([label, value, tone]) => {
    const card = document.createElement("div");
    card.className = `stat${tone ? ` ${tone}` : ""}`;
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("strong");
    count.textContent = String(value);
    card.append(name, count);
    return card;
  }));
}

function renderTaskList() {
  elements.taskCount.textContent = `${state.filtered.length}/${state.tasks.length}`;
  if (!state.filtered.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = state.tasks.length ? "没有匹配的任务" : "尚未读取任务";
    elements.taskList.replaceChildren(empty);
    return;
  }
  const cards = state.filtered.map((task, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `task-card${task.taskId === state.selectedTaskId ? " active" : ""}`;
    card.addEventListener("click", () => {
      state.selectedTaskId = task.taskId;
      renderTaskList();
      renderDetail();
    });
    const line = document.createElement("div");
    line.className = "task-line";
    const proposer = document.createElement("span");
    proposer.className = "task-proposer";
    proposer.textContent = `${String(index + 1).padStart(2, "0")} · ${task.proposer || task.targetKey}`;
    line.append(proposer, badge(task.status));
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `${task.targetKey} · ${task.stage} · ${task.cursorBefore ?? "—"} → ${task.targetMessageId ?? "—"}`;
    const id = document.createElement("div");
    id.className = "task-id";
    id.textContent = task.taskId;
    card.append(line, meta, id);
    return card;
  });
  elements.taskList.replaceChildren(...cards);
}

function stringify(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function codePanel({ kicker, title, note, value, emptyMessage, expanded = true, compact = false }) {
  const panel = elements.codeTemplate.content.firstElementChild.cloneNode(true);
  if (compact) panel.classList.add("compact");
  panel.querySelector(".panel-kicker").textContent = kicker;
  panel.querySelector(".panel-title").textContent = title;
  const noteNode = panel.querySelector(".panel-note");
  if (note) noteNode.textContent = note;
  else noteNode.remove();
  const content = panel.querySelector(".panel-content");
  const toggle = panel.querySelector(".panel-toggle");
  const mark = panel.querySelector(".toggle-mark");
  const pre = panel.querySelector("pre");
  const code = panel.querySelector("code");
  if (value === null || value === undefined) {
    pre.className = "no-output";
    code.textContent = emptyMessage || "没有持久化数据";
  } else {
    code.textContent = stringify(value);
  }
  function setExpanded(next) {
    content.hidden = !next;
    toggle.setAttribute("aria-expanded", String(next));
    mark.textContent = next ? "−" : "+";
    panel.classList.toggle("collapsed", !next);
  }
  toggle.addEventListener("click", () => setExpanded(toggle.getAttribute("aria-expanded") !== "true"));
  setExpanded(expanded);
  panel.querySelector(".copy-button").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(value === null || value === undefined ? "" : stringify(value));
      event.currentTarget.textContent = "已复制";
    } catch {
      event.currentTarget.textContent = "复制失败";
    }
    window.setTimeout(() => { event.currentTarget.textContent = "复制"; }, 900);
  });
  return panel;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function formatDuration(start, end) {
  const milliseconds = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  if (milliseconds < 3600000) return `${Math.floor(milliseconds / 60000)}m ${Math.round((milliseconds % 60000) / 1000)}s`;
  return `${Math.floor(milliseconds / 3600000)}h ${Math.round((milliseconds % 3600000) / 60000)}m`;
}

function factCard(label, value, tone = "") {
  const card = document.createElement("div");
  card.className = `fact-card${tone ? ` ${tone}` : ""}`;
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value ?? "—";
  card.append(name, content);
  return card;
}

function sectionStatusSummary(result) {
  const sections = result?.sectionResults;
  if (!sections || typeof sections !== "object") return "没有结果";
  return Object.entries(sections).map(([section, value]) => {
    const count = Array.isArray(value?.changes) ? ` · ${value.changes.length} changes`
      : Array.isArray(value?.patches) ? ` · ${value.patches.length} patches`
        : "";
    return `${section}: ${value?.status || "unknown"}${count}`;
  }).join("\n");
}

function resultCard(title, status, summary) {
  const card = document.createElement("div");
  card.className = "result-card";
  const head = document.createElement("div");
  head.className = "result-card-head";
  const heading = document.createElement("h4");
  heading.textContent = title;
  head.append(heading, badge(status));
  const text = document.createElement("p");
  text.textContent = summary;
  card.append(head, text);
  return card;
}

function callout(kind, title, message) {
  const node = document.createElement("div");
  node.className = `callout${kind ? ` ${kind}` : ""}`;
  node.append(badge(kind || "info"));
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  text.append(strong, document.createTextNode(` ${message}`));
  node.append(text);
  return node;
}

function diagnosticSection(task, { includeDetails = false } = {}) {
  const section = document.createElement("section");
  section.className = "diagnostics";
  const title = document.createElement("h3");
  title.textContent = `Ops timeline · ${task.ops.length}`;
  section.append(title);
  if (!task.ops.length) {
    const empty = document.createElement("div");
    empty.className = "callout";
    empty.textContent = "没有持久化的异常 / 重试 ops。成功路径目前不会逐阶段写 ops。";
    section.append(empty);
    return section;
  }
  for (const op of task.ops) {
    const card = document.createElement("div");
    card.className = "op-card";
    const head = document.createElement("div");
    head.className = "op-head";
    head.append(badge(op.outcome));
    const attempt = document.createElement("span");
    attempt.className = "task-id";
    attempt.textContent = `attempt ${op.attempt ?? "—"}`;
    head.append(attempt);
    card.append(head);
    const meta = document.createElement("div");
    meta.className = "op-meta";
    meta.textContent = `${formatDate(op.createdAt)} · ${op.proposer || task.proposer || "—"}${op.section ? ` · ${op.section}` : ""}`;
    card.append(meta);
    const errors = Array.isArray(op.detail?.errors) ? op.detail.errors : [];
    if (errors.length) {
      const list = document.createElement("ul");
      list.className = "error-list";
      for (const error of errors) {
        const item = document.createElement("li");
        const path = document.createElement("span");
        path.className = "error-path";
        path.textContent = error.path || "$";
        const message = document.createElement("span");
        message.textContent = error.message || "invalid";
        item.append(path, message);
        list.append(item);
      }
      card.append(list);
    }
    if (includeDetails && op.detail) {
      const detail = codePanel({ kicker: "OP DETAIL", title: "完整诊断记录", value: op.detail, expanded: false, compact: true });
      detail.classList.add("op-detail");
      card.append(detail);
    }
    section.append(card);
  }
  return section;
}

function overviewView(task) {
  const view = document.createElement("section");
  view.className = "view-section";
  const semantic = task.output.semanticResult || task.output.unableResult;
  const effectiveMessageCount = task.input.effectiveEnvelope?.artifact?.publicInput?.messages?.length
    ?? task.input.providerUserPayload?.messages?.length
    ?? 0;
  const baseMessageCount = task.input.persistedEnvelope?.artifact?.publicInput?.messages?.length ?? 0;
  const schemaRetries = Number(task.stagePayload?.schemaInvalidAttempts || 0);
  const inputVariant = task.input.semanticInputVariant || "base";
  const summaryHeading = document.createElement("h3");
  summaryHeading.className = "section-heading";
  summaryHeading.textContent = "Execution summary";
  const summary = document.createElement("div");
  summary.className = "summary-grid";
  summary.append(
    factCard("Stage", task.stage || "—", task.status === "failed" ? "error" : ""),
    factCard("Input variant", inputVariant, inputVariant === "expanded" ? "attention" : ""),
    factCard("Messages", inputVariant === "expanded" ? `${baseMessageCount} → ${effectiveMessageCount}` : String(effectiveMessageCount)),
    factCard("Cursor", `${task.cursorBefore ?? "—"} → ${task.targetMessageId ?? "—"}`),
    factCard("Retries", `provider ${task.attempt || 0} · schema ${schemaRetries} · expand ${task.contextExpansionAttempt || 0}`, (task.attempt || schemaRetries || task.contextExpansionAttempt) ? "attention" : ""),
    factCard("Revision", `${task.baseRevision} → ${task.resultRevision ?? "—"}`),
    factCard("Created", formatDate(task.createdAt)),
    factCard("Updated / elapsed", `${formatDate(task.updatedAt)} · ${formatDuration(task.createdAt, task.updatedAt)}`),
  );
  view.append(summaryHeading, summary);

  const results = document.createElement("section");
  results.className = "overview-block";
  const resultsHeading = document.createElement("h3");
  resultsHeading.className = "section-heading";
  resultsHeading.textContent = "Result digest";
  const cards = document.createElement("div");
  cards.className = "result-grid";
  cards.append(
    resultCard("Semantic", semantic ? "persisted" : task.output.availability, sectionStatusSummary(semantic)),
    resultCard("Compiler", task.output.compiledProposal ? "persisted" : "empty", sectionStatusSummary(task.output.compiledProposal)),
    resultCard("Diagnostics", task.ops.length ? `${task.ops.length} events` : "clean", task.lastErrorReason ? `last error: ${task.lastErrorReason}` : "没有当前错误原因"),
  );
  results.append(resultsHeading, cards);
  view.append(results);

  const timeline = document.createElement("section");
  timeline.className = "overview-block";
  const timelineHeading = document.createElement("h3");
  timelineHeading.className = "section-heading";
  timelineHeading.textContent = "Exceptions and retries";
  timeline.append(timelineHeading, diagnosticSection(task));
  view.append(timeline);
  return view;
}

function providerView(task) {
  const view = document.createElement("section");
  view.className = "view-section";
  view.append(callout("warning", "Prompt 非历史快照。", "这里用当前工作区 Prompt 重建；它可能与任务执行时的版本不同。"));
  const grid = document.createElement("div");
  grid.className = "panel-grid";
  const left = document.createElement("div");
  left.className = "panel-stack";
  left.append(
    codePanel({ kicker: "SYSTEM", title: task.input.currentRepairPrompt ? "当前 Prompt + repair feedback" : "当前 Prompt", note: "Prompt 本身未随 task 保存；这里展示当前工作区版本。", value: task.input.currentRepairPrompt || task.input.currentPrompt, emptyMessage: task.input.reconstructionError || "无法重建 Prompt" }),
    codePanel({ kicker: "JSON SCHEMA", title: "Response schema", note: "根据 proposer 与 targetSections 从当前代码重建。", value: task.input.responseSchema, expanded: false }),
  );
  const right = document.createElement("div");
  right.className = "panel-stack";
  right.append(codePanel({ kicker: "USER PAYLOAD", title: "Actual provider user payload", note: "由 effective durable envelope 显式投影；不发送 taskId、task.now 与 private artifact metadata。", value: task.input.providerUserPayload }));
  grid.append(left, right);
  view.append(grid);
  return view;
}

function durableView(task) {
  const view = document.createElement("section");
  view.className = "view-section";
  const missingOutput = task.output.availability === "invalid_output_not_persisted"
    ? "Schema 无效的模型原文按隐私设计不会落库；请到“诊断”查看校验路径。"
    : "该任务没有持久化 Semantic result。";
  const grid = document.createElement("div");
  grid.className = "panel-grid";
  const results = document.createElement("div");
  results.className = "panel-stack";
  results.append(
    codePanel({ kicker: "SEMANTIC IR", title: "Persisted Semantic result", note: "来自 stage_payload.semanticResult。", value: task.output.semanticResult, emptyMessage: missingOutput }),
    codePanel({ kicker: "UNABLE", title: "Persisted unable result", note: "来自 stage_payload.unableResult；该分支不会进入 Compiler。", value: task.output.unableResult, expanded: Boolean(task.output.unableResult) }),
    codePanel({ kicker: "COMPILED", title: "Compiled proposal", note: "来自 stage_payload.compiledProposal。", value: task.output.compiledProposal }),
  );
  const envelopes = document.createElement("div");
  envelopes.className = "panel-stack";
  envelopes.append(
    codePanel({ kicker: "STAGE", title: "Raw stage payload", note: "retry、context expansion 与持久化阶段的完整状态。", value: task.stagePayload }),
    codePanel({ kicker: "DURABLE INPUT", title: task.input.expandedArtifact ? "Effective expanded envelope" : "Persisted task envelope", note: task.input.expandedArtifact ? "由 immutable base envelope 与 durable expandedArtifact 重建。" : "来自 chat_memory_tasks.task_payload。", value: task.input.effectiveEnvelope, expanded: false }),
  );
  if (task.input.expandedArtifact) {
    envelopes.append(codePanel({ kicker: "ORIGINAL", title: "Original persisted envelope", value: task.input.persistedEnvelope, expanded: false }));
  }
  grid.append(results, envelopes);
  view.append(grid);
  return view;
}

function diagnosticsView(task) {
  const view = document.createElement("section");
  view.className = "view-section";
  if (task.lastErrorReason) view.append(callout("error", "Last error.", task.lastErrorReason));
  if (task.notBefore) view.append(callout("warning", "Retry scheduled.", formatDate(task.notBefore)));
  if (task.input.reconstructionError) view.append(callout("error", "Reconstruction failed.", task.input.reconstructionError));
  if (task.output.availability === "invalid_output_not_persisted") {
    view.append(callout("warning", "原始无效输出不可用。", "隐私设计只持久化校验错误，不保存 Provider 原文。"));
  }
  const grid = document.createElement("div");
  grid.className = "panel-grid";
  const timeline = document.createElement("div");
  timeline.append(diagnosticSection(task, { includeDetails: true }));
  const durable = document.createElement("div");
  durable.className = "panel-stack";
  durable.append(
    codePanel({ kicker: "REPAIR", title: "Schema repair feedback", note: "下一次 Provider 调用使用的结构化修复提示。", value: task.input.repairFeedback, expanded: Boolean(task.input.repairFeedback), compact: true }),
    codePanel({ kicker: "STAGE", title: "Raw stage payload", value: task.stagePayload, expanded: false, compact: true }),
  );
  grid.append(timeline, durable);
  view.append(grid);
  return view;
}

const DETAIL_VIEWS = Object.freeze({
  overview: { label: "概览", render: overviewView },
  provider: { label: "Provider I/O", render: providerView },
  durable: { label: "持久化", render: durableView },
  diagnostics: { label: "诊断", render: diagnosticsView },
});

function detailTabs(task) {
  const tabs = document.createElement("nav");
  tabs.className = "detail-tabs";
  tabs.setAttribute("role", "tablist");
  for (const [key, descriptor] of Object.entries(DETAIL_VIEWS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `detail-tab${key === state.activeView ? " active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(key === state.activeView));
    button.textContent = descriptor.label;
    if (key === "diagnostics" && task.ops.length) {
      const count = document.createElement("span");
      count.className = "tab-count";
      count.textContent = String(task.ops.length);
      button.append(count);
    }
    button.addEventListener("click", () => {
      state.activeView = key;
      renderDetail();
    });
    tabs.append(button);
  }
  return tabs;
}

function renderDetail() {
  const task = state.tasks.find((item) => item.taskId === state.selectedTaskId);
  if (!task) {
    elements.detail.className = "detail empty-state";
    const wrapper = document.createElement("div");
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "⌁";
    const title = document.createElement("h2");
    title.textContent = "选择一个任务";
    const message = document.createElement("p");
    message.textContent = "输入、输出、Schema 错误和持久化阶段会显示在这里。";
    wrapper.append(icon, title, message);
    elements.detail.replaceChildren(wrapper);
    return;
  }
  elements.detail.className = "detail";
  const header = document.createElement("header");
  header.className = "detail-title";
  const titleGroup = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "section-label";
  kicker.textContent = `GENERATION ${task.sourceGeneration} / ${task.targetKey}`;
  const title = document.createElement("h2");
  title.textContent = task.proposer || task.targetKey;
  const id = document.createElement("p");
  id.textContent = task.taskId;
  titleGroup.append(kicker, title, id);
  header.append(titleGroup, badge(task.status));

  const meta = document.createElement("div");
  meta.className = "meta-strip";
  [task.taskType, task.stage, task.input.semanticInputVariant, `attempt ${task.attempt}`, task.lastErrorReason]
    .filter(Boolean).forEach((value) => meta.append(badge(value)));

  const descriptor = DETAIL_VIEWS[state.activeView] || DETAIL_VIEWS.overview;
  elements.detail.replaceChildren(header, meta, detailTabs(task), descriptor.render(task));
  elements.detail.scrollTop = 0;
}

function renderAll() {
  renderStats();
  renderTaskList();
  renderDetail();
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadTasks({ reloadGenerations: true });
});
elements.refreshButton.addEventListener("click", () => loadTasks({ reloadGenerations: true }));
elements.generation.addEventListener("change", () => loadTasks({ reloadGenerations: false }));
elements.search.addEventListener("input", applyFilters);
elements.targetFilter.addEventListener("change", applyFilters);
elements.statusFilter.addEventListener("change", applyFilters);

restoreScope();
renderAll();
