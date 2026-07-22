const crypto = require("node:crypto");
const { SCHEMA_VERSION, validateRendererArtifact } = require("../contracts");
const {
  buildProposerTaskArtifact,
  renderMemoryAndRefs,
} = require("./proposerTaskRenderer");

function buildNormalEnvelope({
  userId,
  presetId,
  state,
  intent,
  messages,
  now,
  userTimeZone = "UTC",
  taskId = crypto.randomUUID(),
  tickId = Date.now(),
  config,
}) {
  if (state?.version !== SCHEMA_VERSION) throw new Error("Memory tasks require a 2.01 state");
  const artifact = buildProposerTaskArtifact({
    state,
    intent,
    messages,
    now,
    userTimeZone,
    taskId,
    tickId,
    overdueTodoLimit: config?.overdueTodos?.maxRenderedItems,
  });
  const publicTask = artifact.publicInput.task;
  return {
    task: {
      ...publicTask,
      userId: Number(userId),
      presetId: String(presetId),
      schemaVersion: SCHEMA_VERSION,
      sourceGeneration: state.meta.sourceGeneration,
      baseRevision: state.meta.revision,
      mode: "normal",
      observedMessageIds: artifact.publicInput.messages.map((message) => message.id),
      trigger: structuredClone(intent.trigger || { type: "lagThreshold" }),
    },
    artifact,
  };
}

function isSemanticTaskEnvelope(envelope) {
  return envelope?.task?.schemaVersion === SCHEMA_VERSION
    && Boolean(envelope?.artifact?.publicInput);
}

function normalDedupeKey(task) {
  return ["normal", task.sourceGeneration, task.targetKey, task.cursorBefore, task.targetMessageId].join(":");
}

function buildMaintenanceEnvelope({
  parentEnvelope,
  state,
  section,
  violation,
  trigger,
  taskId = crypto.randomUUID(),
  tickId = Date.now(),
  resumeEpoch = 0,
  config,
}) {
  if (state?.version !== SCHEMA_VERSION) throw new Error("Memory maintenance requires a 2.01 state");
  const targetMessageId = parentEnvelope.task.targetMessageId;
  const publicTask = {
    taskId,
    tickId,
    targetKey: parentEnvelope.task.targetKey,
    proposer: "compactionProposer",
    targetSections: [section],
    cursorBefore: Math.max(0, targetMessageId - 1),
    targetMessageId,
    now: new Date(parentEnvelope.task.now).toISOString(),
    userTimeZone: parentEnvelope.task.userTimeZone ?? "UTC",
  };
  const rendered = renderMemoryAndRefs(state, "compactionProposer", [section], {
    overdueTodoLimit: config?.overdueTodos?.maxRenderedItems,
  });
  const artifact = {
    publicInput: { task: publicTask, memoryText: rendered.memoryText, messages: [] },
    refMap: rendered.refMap,
    messageMeta: {},
  };
  const validation = validateRendererArtifact(artifact);
  if (!validation.ok) {
    throw new Error(`Invalid compaction Renderer artifact: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
  }
  return {
    task: {
      ...publicTask,
      userId: parentEnvelope.task.userId,
      presetId: parentEnvelope.task.presetId,
      schemaVersion: SCHEMA_VERSION,
      sourceGeneration: parentEnvelope.task.sourceGeneration,
      baseRevision: state.meta.revision,
      mode: "maintenance",
      observedMessageIds: [],
      trigger: structuredClone(trigger || { type: "lengthBudget", dimension: violation.dimension, limit: violation.limit }),
      parentTaskId: parentEnvelope.task.taskId,
      resumeEpoch,
    },
    artifact,
  };
}

function maintenanceDedupeKey(task) {
  if (task.trigger?.type === "hygiene") return ["maintenance", "hygiene", task.sourceGeneration, task.parentTaskId, task.targetSections[0], task.baseRevision].join(":");
  return ["maintenance", task.sourceGeneration, task.parentTaskId, task.targetSections[0], task.resumeEpoch].join(":");
}

module.exports = {
  buildNormalEnvelope,
  buildSemanticNormalEnvelope: buildNormalEnvelope,
  isSemanticTaskEnvelope,
  buildMaintenanceEnvelope,
  normalDedupeKey,
  maintenanceDedupeKey,
};
