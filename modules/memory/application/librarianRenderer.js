const crypto = require("node:crypto");
const {
  LIBRARIAN_PROPOSER,
  LIBRARIAN_SECTIONS,
  LIBRARIAN_TARGET_KEY,
  validateLibrarianArtifact,
} = require("../contracts");
const { renderMemoryAndRefs } = require("./proposerTaskRenderer");
const { captureWriteLimits } = require("../contracts/sectionPolicy");

function renderLibrarianMemory(state) {
  return renderMemoryAndRefs(state, LIBRARIAN_PROPOSER, LIBRARIAN_SECTIONS);
}

function buildLibrarianEnvelope({
  userId,
  presetId,
  state,
  config,
  boundaryMessageId,
  watermarkOrdinal,
  watermarkKind = "complete_turn",
  triggerType,
  now = new Date(),
  userTimeZone,
  taskId = crypto.randomUUID(),
  tickId = Date.now(),
} = {}) {
  const rendered = renderLibrarianMemory(state);
  const publicTask = {
    taskId,
    tickId,
    proposer: LIBRARIAN_PROPOSER,
    targetKey: LIBRARIAN_TARGET_KEY,
    targetSections: LIBRARIAN_SECTIONS.slice(),
    boundaryMessageId,
    watermarkOrdinal,
    watermarkKind,
    triggerType,
    writeLimits: captureWriteLimits(config),
    now: new Date(now).toISOString(),
    userTimeZone,
  };
  const artifact = {
    publicInput: { task: publicTask, memoryText: rendered.memoryText, evidenceText: rendered.evidenceText, messages: [] },
    refMap: rendered.refMap,
    messageMeta: {},
  };
  const validation = validateLibrarianArtifact(artifact);
  if (!validation.ok) {
    const error = new Error(`Invalid Librarian Renderer artifact: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_LIBRARIAN_ARTIFACT_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return {
    task: {
      ...publicTask,
      userId: Number(userId),
      presetId: String(presetId),
      schemaVersion: state.version,
      sourceGeneration: state.meta.sourceGeneration,
      baseRevision: state.meta.revision,
      mode: "librarian",
      observedMessageIds: [],
      trigger: { type: triggerType, boundaryMessageId, watermarkOrdinal, watermarkKind },
    },
    artifact,
  };
}

function librarianDedupeKey(task) {
  return ["maintenance", "librarian", task.sourceGeneration, task.watermarkKind, task.triggerType, task.watermarkOrdinal, task.boundaryMessageId, task.baseRevision].join(":");
}

module.exports = { renderLibrarianMemory, buildLibrarianEnvelope, librarianDedupeKey };
