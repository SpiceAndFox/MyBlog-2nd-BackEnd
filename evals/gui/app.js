"use strict";

const state = {
  scope: null,
  generation: null,
  tasks: [],
  filtered: [],
  selectedTaskId: null,
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
  const previous = preserveGeneration ? elements.generation.value : null;
  const data = await fetchJson(apiUrl("/api/generations", scope));
  state.scope = data.scope;
  elements.generation.replaceChildren();
  if (!data.generations.length) {
    elements.generation.append(option("", "没有 proposer task"));
    elements.generation.disabled = true;
    return null;
  }
  elements.generation.append(option("all", `全部 generations · ${data.generations.reduce((sum, item) => sum + item.taskCount, 0)} tasks`));
  for (const generation of data.generations) {
    const failed = generation.statuses.failed || 0;
    const suffix = failed ? ` · ${failed} failed` : "";
    elements.generation.append(option(String(generation.sourceGeneration), `Generation ${generation.sourceGeneration} · ${generation.taskCount} tasks${suffix}`));
  }
  elements.generation.disabled = false;
  const available = [...elements.generation.options].some((item) => item.value === previous);
  elements.generation.value = available && previous ? previous : String(data.generations[0].sourceGeneration);
  return elements.generation.value;
}

async function loadTasks({ reloadGenerations = true } = {}) {
  setBusy(true, "正在读取持久化任务…");
  try {
    if (reloadGenerations) await loadGenerations();
    if (!state.scope || elements.generation.disabled) {
      state.tasks = [];
      renderAll();
      setBusy(false, "该 scope 没有 proposer task。 ");
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
    setBusy(false, `已读取 ${data.taskCount} 个任务；数据来自持久化 task / ops 记录。`);
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
  const values = [
    ["Tasks", tasks.length],
    ["Succeeded", tasks.filter((task) => task.status === "succeeded").length],
    ["Failed", tasks.filter((task) => task.status === "failed").length],
    ["Provider attempts", tasks.reduce((sum, task) => sum + Math.max(1, task.attempt || 0), 0)],
    ["Targets", new Set(tasks.map((task) => task.targetKey)).size],
  ];
  elements.stats.replaceChildren(...values.map(([label, value]) => {
    const card = document.createElement("div");
    card.className = "stat";
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
    meta.textContent = `${task.targetKey} · g${task.sourceGeneration} · cursor ${task.cursorBefore ?? "—"} → ${task.targetMessageId ?? "—"}`;
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

function codePanel({ kicker, title, note, value, emptyMessage }) {
  const panel = elements.codeTemplate.content.firstElementChild.cloneNode(true);
  panel.querySelector(".panel-kicker").textContent = kicker;
  panel.querySelector("h3").textContent = title;
  const noteNode = panel.querySelector(".panel-note");
  if (note) noteNode.textContent = note;
  else noteNode.remove();
  const pre = panel.querySelector("pre");
  const code = panel.querySelector("code");
  if (value === null || value === undefined) {
    pre.className = "no-output";
    code.textContent = emptyMessage || "没有持久化数据";
  } else {
    code.textContent = stringify(value);
  }
  panel.querySelector(".copy-button").addEventListener("click", async (event) => {
    await navigator.clipboard.writeText(value === null || value === undefined ? "" : stringify(value));
    event.currentTarget.textContent = "已复制";
    window.setTimeout(() => { event.currentTarget.textContent = "复制"; }, 900);
  });
  return panel;
}

function diagnosticSection(task) {
  const section = document.createElement("section");
  section.className = "diagnostics";
  const title = document.createElement("h3");
  title.textContent = `Ops / Diagnostics · ${task.ops.length}`;
  section.append(title);
  if (!task.ops.length) {
    const empty = document.createElement("div");
    empty.className = "op-card";
    empty.textContent = "该任务没有 ops 诊断记录。";
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
    section.append(card);
  }
  return section;
}

function renderDetail() {
  const task = state.tasks.find((item) => item.taskId === state.selectedTaskId);
  if (!task) {
    elements.detail.className = "detail empty-state";
    elements.detail.innerHTML = "<div><span class=\"empty-icon\">⌁</span><h2>选择一个任务</h2><p>输入、输出、Schema 错误和持久化阶段会显示在这里。</p></div>";
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
  [task.taskType, task.stage, `attempt ${task.attempt}`, `revision ${task.baseRevision} → ${task.resultRevision ?? "—"}`, task.lastErrorReason]
    .filter(Boolean).forEach((value) => meta.append(badge(value)));

  const grid = document.createElement("div");
  grid.className = "io-grid";
  const inputColumn = document.createElement("div");
  inputColumn.className = "io-column";
  const inputTitle = document.createElement("h3");
  inputTitle.className = "column-title";
  inputTitle.textContent = "PROVIDER INPUT";
  inputColumn.append(
    inputTitle,
    codePanel({ kicker: "SYSTEM", title: task.input.currentRepairPrompt ? "当前 Prompt + repair feedback" : "当前 Prompt", note: "Prompt 本身未随 task 保存；这里展示当前工作区版本。", value: task.input.currentRepairPrompt || task.input.currentPrompt, emptyMessage: task.input.reconstructionError || "无法重建 Prompt" }),
    codePanel({ kicker: "USER PAYLOAD", title: task.input.expandedEnvelope ? "Effective expanded envelope" : "Persisted task envelope", note: task.input.expandedEnvelope ? "该任务发生过 context expansion；这里展示扩展后的 Provider 输入。" : "来自 chat_memory_tasks.task_payload。", value: task.input.effectiveEnvelope }),
    codePanel({ kicker: "JSON SCHEMA", title: "Response schema", note: "根据 proposer 与 targetSections 从当前代码重建。", value: task.input.responseSchema }),
  );
  if (task.input.expandedEnvelope) {
    inputColumn.append(codePanel({ kicker: "ORIGINAL", title: "Original persisted envelope", value: task.input.persistedEnvelope }));
  }

  const outputColumn = document.createElement("div");
  outputColumn.className = "io-column";
  const outputTitle = document.createElement("h3");
  outputTitle.className = "column-title";
  outputTitle.textContent = "PROVIDER OUTPUT / DURABLE RESULT";
  const missingOutput = task.output.availability === "invalid_output_not_persisted"
    ? "Schema 无效的模型原文按隐私设计不会落库；请查看下方校验路径。"
    : "该任务没有持久化 proposal。";
  outputColumn.append(
    outputTitle,
    codePanel({ kicker: "OUTPUT", title: "Persisted proposal", note: "来自 stage_payload.persistedProposal。", value: task.output.persistedProposal, emptyMessage: missingOutput }),
    codePanel({ kicker: "STAGE", title: "Raw stage payload", note: "用于查看 retry、context expansion 与持久化阶段。", value: task.stagePayload }),
    diagnosticSection(task),
  );
  grid.append(inputColumn, outputColumn);
  elements.detail.replaceChildren(header, meta, grid);
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
