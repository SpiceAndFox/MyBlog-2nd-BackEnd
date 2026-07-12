const crypto = require("node:crypto");
const { SCHEMA_VERSION, TARGETS } = require("../contracts");

const READ_ONLY = Object.freeze({
  currentStateProposer: ["working.recentEpisodes"],
  todoProposer: ["current.scene", "working.standingAgreements", "working.recentEpisodes", "longTerm.userProfile", "longTerm.assistantProfile"],
  agreementProposer: ["current.scene", "working.todos", "working.recentEpisodes", "longTerm.relationship", "longTerm.userProfile", "longTerm.assistantProfile"],
  episodeProposer: ["current.scene", "working.todos", "working.standingAgreements", "longTerm.relationship", "longTerm.userProfile", "longTerm.assistantProfile"],
  profileRelationshipProposer: ["current.scene", "working.recentEpisodes", "working.standingAgreements", "longTerm.milestones", "longTerm.worldFacts"],
  worldFactProposer: ["current.scene", "working.recentEpisodes", "working.standingAgreements", "longTerm.milestones", "longTerm.userProfile", "longTerm.assistantProfile", "longTerm.relationship"],
});

function redactScene(scene) {
  return Object.fromEntries(Object.entries(scene).map(([key, field]) => [key, { value: field.value, updatedAtMessageId: field.updatedAtMessageId }]));
}
function redactItem(item, writable) {
  const result = { text: item.text, createdAtMessageId: item.createdAtMessageId, updatedAtMessageId: item.updatedAtMessageId };
  if (writable) result.id = item.id;
  for (const key of ["actor", "requester", "status", "becameOverdueAt", "dueAt"]) {
    if (Object.prototype.hasOwnProperty.call(item, key)) result[key] = item[key];
  }
  return result;
}
function readPath(state, path, writable, overdueLimit) {
  const [container, section] = path.split(".");
  if (section === "scene") return redactScene(state.current.scene);
  let items = state[container][section];
  if (section === "todos") {
    if (!writable) items = items.filter((item) => item.status === "active");
    else {
      const active = items.filter((item) => item.status === "active");
      const overdue = items.filter((item) => item.status === "overdue")
        .sort((a, b) => String(b.becameOverdueAt).localeCompare(String(a.becameOverdueAt)) || a.id.localeCompare(b.id))
        .slice(0, overdueLimit);
      items = [...active, ...overdue];
    }
  }
  return items.map((item) => redactItem(item, writable));
}
function putPath(output, path, value) {
  const [container, section] = path.split(".");
  output[container] ||= {};
  output[container][section] = value;
}
function sectionPath(section) {
  if (section === "scene") return "current.scene";
  if (["todos", "standingAgreements", "recentEpisodes"].includes(section)) return `working.${section}`;
  return `longTerm.${section}`;
}
function buildStateViews(state, proposer, targetSections, config) {
  const writableState = {};
  for (const section of targetSections) {
    const path = sectionPath(section);
    putPath(writableState, path, readPath(state, path, true, config.overdueTodos.maxRenderedItems));
  }
  const readOnlyContext = {};
  for (const path of READ_ONLY[proposer]) {
    if (targetSections.includes(path.split(".")[1])) continue;
    putPath(readOnlyContext, path, readPath(state, path, false, config.overdueTodos.maxRenderedItems));
  }
  return { writableState, readOnlyContext };
}
function buildNormalEnvelope({ userId, presetId, state, intent, messages, now, taskId = crypto.randomUUID(), tickId = Date.now(), config }) {
  if (!messages.length) throw new Error("A normal Memory task requires a non-empty new batch");
  const observedMessageIds = messages.map((message) => message.id);
  const targetMessageId = Math.max(...messages.filter((message) => message.id > intent.cursorBefore).map((message) => message.id));
  if (!Number.isSafeInteger(targetMessageId)) throw new Error("Observed window does not contain a new batch");
  const { writableState, readOnlyContext } = buildStateViews(state, intent.proposer, intent.targetSections, config);
  return {
    task: {
      taskId, tickId, userId: Number(userId), presetId: String(presetId), schemaVersion: SCHEMA_VERSION,
      sourceGeneration: state.meta.sourceGeneration, baseRevision: state.meta.revision,
      targetKey: intent.targetKey, cursorBefore: intent.cursorBefore, targetMessageId,
      proposer: intent.proposer, mode: "normal", targetSections: intent.targetSections.slice(),
      observedMessageIds, trigger: { type: "lagThreshold" }, now: new Date(now).toISOString(),
    },
    writableState, readOnlyContext, observedMessages: messages,
  };
}
function normalDedupeKey(task) {
  return ["normal", task.sourceGeneration, task.targetKey, task.cursorBefore, task.targetMessageId].join(":");
}

function buildMaintenanceEnvelope({ parentEnvelope, state, section, violation, taskId = crypto.randomUUID(), tickId = Date.now(), resumeEpoch = 0, config }) {
  const path = sectionPath(section);
  const writableState = {};
  putPath(writableState, path, readPath(state, path, true, config.overdueTodos.maxRenderedItems));
  return {
    task: {
      taskId,
      tickId,
      userId: parentEnvelope.task.userId,
      presetId: parentEnvelope.task.presetId,
      schemaVersion: SCHEMA_VERSION,
      sourceGeneration: parentEnvelope.task.sourceGeneration,
      baseRevision: state.meta.revision,
      targetKey: parentEnvelope.task.targetKey,
      targetMessageId: parentEnvelope.task.targetMessageId,
      proposer: "compactionProposer",
      mode: "maintenance",
      targetSections: [section],
      observedMessageIds: [],
      trigger: { type: "lengthBudget", dimension: violation.dimension, limit: violation.limit },
      now: new Date(parentEnvelope.task.now).toISOString(),
      parentTaskId: parentEnvelope.task.taskId,
      resumeEpoch,
    },
    writableState,
    readOnlyContext: {},
    observedMessages: [],
  };
}

function maintenanceDedupeKey(task) {
  return ["maintenance", task.sourceGeneration, task.parentTaskId, task.targetSections[0], task.resumeEpoch].join(":");
}

module.exports = { READ_ONLY, buildStateViews, buildNormalEnvelope, buildMaintenanceEnvelope, normalDedupeKey, maintenanceDedupeKey, redactItem, redactScene };
