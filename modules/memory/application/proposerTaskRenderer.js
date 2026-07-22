const crypto = require("node:crypto");
const {
  TARGETS, READ_ONLY_CONTEXT_PATHS, SCENE_FIELDS,
  normalizeSourceRefs, validateRendererArtifact,
} = require("../contracts");

const REF_PREFIX = Object.freeze({
  scene: "S",
  todos: "T",
  standingAgreements: "A",
  recentEpisodes: "E",
  milestones: "M",
  worldFacts: "W",
  userProfile: "UP",
  assistantProfile: "AP",
  relationship: "R",
});

const SECTION_LABELS = Object.freeze({
  scene: "场景",
  todos: "待办",
  standingAgreements: "持续约定",
  recentEpisodes: "最近经历",
  milestones: "重要里程碑",
  worldFacts: "世界事实",
  userProfile: "User 档案",
  assistantProfile: "Assistant 档案",
  relationship: "关系记忆",
});

function sectionPath(section) {
  if (section === "scene") return ["current", "scene"];
  if (["todos", "standingAgreements", "recentEpisodes"].includes(section)) return ["working", section];
  return ["longTerm", section];
}

function getSection(state, section) {
  const [container, key] = sectionPath(section);
  return state?.[container]?.[key];
}

function visibleReadOnlySections(proposer) {
  return (READ_ONLY_CONTEXT_PATHS[proposer] || []).map((path) => path.split(".")[1]);
}

function renderTodo(item) {
  const details = [`actor=${item.actor}`, `requester=${item.requester}`];
  if (item.status) details.push(`status=${item.status}`);
  if (item.dueAt) details.push(`dueAt=${item.dueAt}`);
  return `${item.text} (${details.join(", ")})`;
}

function renderEntry(section, item) {
  return section === "todos" ? renderTodo(item) : item.text;
}

function addSceneRefs({ scene, namespace, map, lines }) {
  for (const path of SCENE_FIELDS) {
    const field = scene?.[path];
    if (!field) continue;
    if (namespace === "readOnly" && field.value === null) continue;
    const ref = `${REF_PREFIX.scene}-${path.toUpperCase()}`;
    const entry = { section: "scene", path };
    if (namespace === "readOnly") entry.sourceRefs = normalizeSourceRefs(field.sourceRefs);
    map[ref] = entry;
    lines.push(`${ref} | ${path}: ${field.value ?? "(空)"}`);
  }
}

function visibleItems(items, section, namespace, overdueTodoLimit) {
  if (section !== "todos") return items || [];
  if (namespace === "readOnly") return (items || []).filter((item) => item.status === "active");
  const active = (items || []).filter((item) => item.status === "active");
  const overdue = (items || []).filter((item) => item.status === "overdue")
    .sort((left, right) => String(right.becameOverdueAt).localeCompare(String(left.becameOverdueAt)) || left.id.localeCompare(right.id));
  return Number.isSafeInteger(overdueTodoLimit) && overdueTodoLimit >= 0
    ? [...active, ...overdue.slice(0, overdueTodoLimit)]
    : [...active, ...overdue];
}

function addItemRefs({ items, section, namespace, map, lines, overdueTodoLimit }) {
  let index = 0;
  for (const item of visibleItems(items, section, namespace, overdueTodoLimit)) {
    index += 1;
    const ref = `${REF_PREFIX[section]}${index}`;
    const entry = { section, itemId: item.id };
    if (namespace === "readOnly") entry.sourceRefs = normalizeSourceRefs(item.sourceRefs);
    map[ref] = entry;
    lines.push(`${ref} | ${renderEntry(section, item)}`);
  }
}

function renderMemoryAndRefs(state, proposer, targetSections, { overdueTodoLimit } = {}) {
  const refMap = { writable: {}, readOnly: {} };
  const blocks = [];
  const scopes = [
    { namespace: "writable", sections: targetSections, heading: "可修改" },
    { namespace: "readOnly", sections: visibleReadOnlySections(proposer), heading: "辅助" },
  ];
  for (const scope of scopes) {
    for (const section of scope.sections) {
      const lines = [];
      const value = getSection(state, section);
      if (section === "scene") addSceneRefs({ scene: value, namespace: scope.namespace, map: refMap[scope.namespace], lines });
      else addItemRefs({ items: value, section, namespace: scope.namespace, map: refMap[scope.namespace], lines, overdueTodoLimit });
      blocks.push(`[${scope.heading}${SECTION_LABELS[section]}]\n${lines.length ? lines.join("\n") : "(无)"}`);
    }
  }
  return { memoryText: blocks.join("\n\n"), refMap };
}

function buildProposerTaskArtifact({
  state,
  intent,
  messages,
  now = new Date(),
  userTimeZone = "UTC",
  taskId = crypto.randomUUID(),
  tickId = Date.now(),
  overdueTodoLimit,
} = {}) {
  if (!state || !intent || !Array.isArray(messages) || messages.length === 0) throw new Error("State, intent and observed messages are required");
  const target = TARGETS[intent.targetKey];
  if (!target || target.proposer !== intent.proposer) throw new Error("Intent does not identify a supported normal Memory target");
  const cursorBefore = Number(intent.cursorBefore ?? 0);
  const targetMessageId = Math.max(...messages.filter((message) => message.id > cursorBefore).map((message) => message.id));
  if (!Number.isSafeInteger(targetMessageId)) throw new Error("Observed messages do not contain a new batch");
  const { memoryText, refMap } = renderMemoryAndRefs(state, intent.proposer, target.sections, { overdueTodoLimit });
  const publicMessages = messages.map((message) => ({
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    content: message.content,
  }));
  const artifact = {
    publicInput: {
      task: {
        taskId,
        tickId,
        proposer: intent.proposer,
        targetKey: intent.targetKey,
        targetSections: target.sections.slice(),
        cursorBefore,
        targetMessageId,
        now: new Date(now).toISOString(),
        userTimeZone,
      },
      memoryText,
      messages: publicMessages,
    },
    refMap,
    messageMeta: Object.fromEntries(messages.map((message) => [String(message.id), {
      role: message.role,
      createdAt: message.createdAt,
      contentHash: message.contentHash,
    }])),
  };
  const validation = validateRendererArtifact(artifact);
  if (!validation.ok) {
    const error = new Error(`Invalid Proposer Renderer artifact: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_RENDERER_ARTIFACT_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return artifact;
}

function expandProposerTaskArtifact(artifact, messages) {
  const current = validateRendererArtifact(artifact);
  if (!current.ok) throw new Error("Cannot expand an invalid Proposer Renderer artifact");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("Expanded observed messages are required");
  const next = structuredClone(artifact);
  next.publicInput.messages = messages.map((message) => ({
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    content: message.content,
  }));
  next.messageMeta = Object.fromEntries(messages.map((message) => [String(message.id), {
    role: message.role,
    createdAt: message.createdAt,
    contentHash: message.contentHash,
  }]));
  const validation = validateRendererArtifact(next);
  if (!validation.ok) {
    const error = new Error(`Invalid expanded Proposer Renderer artifact: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_RENDERER_ARTIFACT_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return next;
}

module.exports = {
  REF_PREFIX,
  SECTION_LABELS,
  sectionPath,
  visibleReadOnlySections,
  renderMemoryAndRefs,
  buildProposerTaskArtifact,
  expandProposerTaskArtifact,
};
