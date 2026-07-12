const {
  SCHEMA_VERSION,
  SECTIONS,
  TARGETS,
  TARGET_KEYS,
  SCENE_FIELDS,
  EVIDENCE_KINDS,
  PATCH_OPS,
  PROPOSER_EVIDENCE_KINDS,
  PROPOSER_RESULT_STATUSES,
  COMPACTION_RESULT_STATUSES,
  QUOTE_MAX_CODE_POINTS,
} = require("./constants");
const { isPlainObject } = require("./state");

const OP_FIELDS = Object.freeze({
  setField: ["op", "path", "value", "evidenceKind", "evidenceRefs"],
  clearField: ["op", "path", "evidenceKind", "evidenceRefs"],
  addItem: ["op", "value", "evidenceKind", "evidenceRefs"],
  updateItem: ["op", "itemId", "value", "evidenceKind", "evidenceRefs"],
  forgetItem: ["op", "itemId", "evidenceKind", "evidenceRefs"],
  mergeItems: ["op", "itemIds", "value", "evidenceKind"],
  completeTodo: ["op", "itemId", "evidenceKind", "evidenceRefs"],
  cancelTodo: ["op", "itemId", "evidenceKind", "evidenceRefs"],
  expireTodo: ["op", "itemId", "evidenceKind", "evidenceRefs"],
  cancelAgreement: ["op", "itemId", "evidenceKind", "evidenceRefs"],
});

function add(errors, path, message) { errors.push({ path, message }); }
function exactObject(value, keys, path, errors) {
  if (!isPlainObject(value)) { add(errors, path, "must be an object"); return false; }
  Object.keys(value).forEach((key) => { if (!keys.includes(key)) add(errors, `${path}.${key}`, "is not allowed"); });
  keys.forEach((key) => { if (!Object.prototype.hasOwnProperty.call(value, key)) add(errors, `${path}.${key}`, "is required"); });
  return true;
}
function positiveText(value) { return typeof value === "string" && value.trim().length > 0; }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }

function validateDueAt(value, path, errors) {
  if (!isPlainObject(value) || !["absolute", "relative"].includes(value.mode)) { add(errors, path, "must be an absolute or relative due expression"); return; }
  if (value.mode === "absolute") {
    if (!exactObject(value, ["mode", "date"], path, errors)) return;
    if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) add(errors, `${path}.date`, "must be YYYY-MM-DD");
    return;
  }
  const allowed = ["mode", "days", "months", "years"];
  Object.keys(value).forEach((key) => { if (!allowed.includes(key)) add(errors, `${path}.${key}`, "is not allowed"); });
  const durations = ["days", "months", "years"].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!durations.length) add(errors, path, "relative due expression needs at least one duration");
  durations.forEach((key) => { if (!Number.isSafeInteger(value[key]) || value[key] < 0) add(errors, `${path}.${key}`, "must be a non-negative safe integer"); });
  if (durations.length && durations.every((key) => value[key] === 0)) add(errors, path, "relative duration must be greater than zero");
}

function validateValue(value, section, op, path, errors) {
  if (op === "setField") {
    if (!positiveText(value)) add(errors, path, "must be a non-empty string");
    return;
  }
  if (!isPlainObject(value)) { add(errors, path, "must be an object"); return; }
  if (op === "mergeItems") {
    if (!exactObject(value, ["text"], path, errors)) return;
    if (!positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
    return;
  }
  if (section !== "todos") {
    if (!exactObject(value, ["text"], path, errors)) return;
    if (!positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
    return;
  }
  if (op === "addItem") {
    const allowed = ["text", "actor", "requester", "dueAt"];
    const required = ["text", "actor", "requester"];
    Object.keys(value).forEach((key) => { if (!allowed.includes(key)) add(errors, `${path}.${key}`, "is not allowed"); });
    required.forEach((key) => { if (!Object.prototype.hasOwnProperty.call(value, key)) add(errors, `${path}.${key}`, "is required"); });
    if (!positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
    if (!["user", "assistant", "both"].includes(value.actor)) add(errors, `${path}.actor`, "is invalid");
    if (!["user", "assistant"].includes(value.requester)) add(errors, `${path}.requester`, "is invalid");
    if (value.dueAt !== undefined) validateDueAt(value.dueAt, `${path}.dueAt`, errors);
    return;
  }
  const allowed = ["text", "actor", "requester", "dueChange"];
  Object.keys(value).forEach((key) => { if (!allowed.includes(key)) add(errors, `${path}.${key}`, "is not allowed"); });
  if (!Object.prototype.hasOwnProperty.call(value, "dueChange")) add(errors, `${path}.dueChange`, "is required");
  if (value.text !== undefined && !positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
  if (value.actor !== undefined && !["user", "assistant", "both"].includes(value.actor)) add(errors, `${path}.actor`, "is invalid");
  if (value.requester !== undefined && !["user", "assistant"].includes(value.requester)) add(errors, `${path}.requester`, "is invalid");
  const dueChange = value.dueChange;
  if (!isPlainObject(dueChange) || !["keep", "clear", "set"].includes(dueChange.mode)) add(errors, `${path}.dueChange`, "has invalid mode");
  else if (dueChange.mode === "set") {
    if (exactObject(dueChange, ["mode", "dueAt"], `${path}.dueChange`, errors)) validateDueAt(dueChange.dueAt, `${path}.dueChange.dueAt`, errors);
  } else exactObject(dueChange, ["mode"], `${path}.dueChange`, errors);
}

function validatePatch(patch, section, { maintenance = false, proposer } = {}) {
  const errors = [];
  const path = "$";
  if (!isPlainObject(patch)) return { ok: false, errors: [{ path, message: "must be an object" }] };
  if (!PATCH_OPS.includes(patch.op)) { add(errors, "$.op", "is invalid"); return { ok: false, errors }; }
  exactObject(patch, OP_FIELDS[patch.op], path, errors);
  if (!SECTIONS.includes(section)) add(errors, "$.section", "is invalid");
  if (maintenance !== (patch.op === "mergeItems")) add(errors, "$.op", maintenance ? "maintenance only permits mergeItems" : "mergeItems is maintenance-only");
  if (patch.op === "setField" || patch.op === "clearField") {
    if (section !== "scene") add(errors, "$.op", "field operations require scene");
    if (!SCENE_FIELDS.includes(patch.path)) add(errors, "$.path", "is invalid");
  } else if (section === "scene") add(errors, "$.op", "item operation cannot target scene");
  const todoOps = ["completeTodo", "cancelTodo", "expireTodo"];
  if (todoOps.includes(patch.op) && section !== "todos") add(errors, "$.op", "requires todos");
  if (patch.op === "cancelAgreement" && section !== "standingAgreements") add(errors, "$.op", "requires standingAgreements");
  if (patch.op === "forgetItem" && !["worldFacts", "userProfile", "assistantProfile", "relationship"].includes(section)) add(errors, "$.op", "forgetItem requires a long-term fact section");
  if (!EVIDENCE_KINDS.includes(patch.evidenceKind)) add(errors, "$.evidenceKind", "is invalid");
  if (proposer && !PROPOSER_EVIDENCE_KINDS[proposer]?.includes(patch.evidenceKind)) add(errors, "$.evidenceKind", `is not allowed for ${proposer}`);
  if (maintenance && patch.evidenceKind !== "memory_compaction") add(errors, "$.evidenceKind", "must be memory_compaction");
  if (patch.itemId !== undefined && !positiveText(patch.itemId)) add(errors, "$.itemId", "must be a non-empty string");
  if (patch.itemIds !== undefined) {
    if (!Array.isArray(patch.itemIds) || patch.itemIds.length < 2 || patch.itemIds.some((id) => !positiveText(id))) add(errors, "$.itemIds", "must contain at least two item ids");
    else if (new Set(patch.itemIds).size !== patch.itemIds.length) add(errors, "$.itemIds", "must not contain duplicates");
  }
  if (patch.value !== undefined) validateValue(patch.value, section, patch.op, "$.value", errors);
  if (patch.evidenceRefs !== undefined) {
    if (!Array.isArray(patch.evidenceRefs) || patch.evidenceRefs.length === 0) add(errors, "$.evidenceRefs", "must be a non-empty array");
    else patch.evidenceRefs.forEach((ref, index) => {
      const refPath = `$.evidenceRefs[${index}]`;
      if (!exactObject(ref, ["messageId", "quote"], refPath, errors)) return;
      if (!nonNegativeInteger(ref.messageId)) add(errors, `${refPath}.messageId`, "must be a non-negative safe integer");
      if (!positiveText(ref.quote)) add(errors, `${refPath}.quote`, "must be a non-empty string");
      else if (Array.from(ref.quote).length > QUOTE_MAX_CODE_POINTS) add(errors, `${refPath}.quote`, `must not exceed ${QUOTE_MAX_CODE_POINTS} code points`);
    });
    if (section === "scene" && patch.evidenceRefs.length !== 1) add(errors, "$.evidenceRefs", "scene operations require exactly one ref");
  }
  return { ok: errors.length === 0, errors };
}

function validateProposerOutput(output, task) {
  const errors = [];
  if (!isPlainObject(task) || !TARGET_KEYS.includes(task.targetKey)) return { ok: false, errors: [{ path: "$.task", message: "has invalid targetKey" }] };
  const maintenance = task.mode === "maintenance";
  const expectedProposer = maintenance ? "compactionProposer" : TARGETS[task.targetKey].proposer;
  const expectedSections = Array.isArray(task.targetSections) ? task.targetSections : TARGETS[task.targetKey].sections;
  if (!exactObject(output, ["tickId", "proposer", "sectionResults"], "$", errors)) return { ok: false, errors };
  if (output.tickId !== task.tickId) add(errors, "$.tickId", "does not match task");
  if (output.proposer !== expectedProposer) add(errors, "$.proposer", "does not match task");
  if (!isPlainObject(output.sectionResults)) add(errors, "$.sectionResults", "must be an object");
  else {
    const actual = Object.keys(output.sectionResults);
    actual.forEach((section) => { if (!expectedSections.includes(section)) add(errors, `$.sectionResults.${section}`, "is not a target section"); });
    expectedSections.forEach((section) => {
      const result = output.sectionResults[section];
      const path = `$.sectionResults.${section}`;
      if (!result) { add(errors, path, "is required"); return; }
      if (!isPlainObject(result)) { add(errors, path, "must be an object"); return; }
      const allowedStatuses = maintenance ? COMPACTION_RESULT_STATUSES : PROPOSER_RESULT_STATUSES;
      if (!allowedStatuses.includes(result.status)) add(errors, `${path}.status`, "is invalid");
      const expectedKeys = result.status === "patches" ? ["status", "patches"] : ["status"];
      exactObject(result, expectedKeys, path, errors);
      if (result.status === "patches") {
        if (!Array.isArray(result.patches) || result.patches.length === 0) add(errors, `${path}.patches`, "must be a non-empty array");
        else result.patches.forEach((patch, index) => {
          const validated = validatePatch(patch, section, { maintenance, proposer: expectedProposer });
          validated.errors.forEach((entry) => add(errors, `${path}.patches[${index}]${entry.path.slice(1)}`, entry.message));
        });
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function validateTaskEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  ["task", "writableState", "readOnlyContext", "observedMessages"].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(envelope, key)) add(errors, `$.${key}`, "is required");
  });
  const task = envelope.task;
  if (!isPlainObject(task)) add(errors, "$.task", "must be an object");
  else {
    if (task.schemaVersion !== SCHEMA_VERSION) add(errors, "$.task.schemaVersion", `must equal ${SCHEMA_VERSION}`);
    if (!TARGET_KEYS.includes(task.targetKey)) add(errors, "$.task.targetKey", "is invalid");
    if (!["normal", "maintenance"].includes(task.mode)) add(errors, "$.task.mode", "is invalid");
    if (!nonNegativeInteger(task.baseRevision)) add(errors, "$.task.baseRevision", "must be a non-negative safe integer");
    if (!nonNegativeInteger(task.sourceGeneration)) add(errors, "$.task.sourceGeneration", "must be a non-negative safe integer");
    if (!Array.isArray(task.targetSections) || task.targetSections.some((section) => !SECTIONS.includes(section))) add(errors, "$.task.targetSections", "is invalid");
    if (task.mode === "normal") {
      if (!nonNegativeInteger(task.cursorBefore)) add(errors, "$.task.cursorBefore", "is required for normal mode");
      if (task.trigger?.type !== "lagThreshold") add(errors, "$.task.trigger", "must be lagThreshold for normal mode");
    } else {
      if (task.cursorBefore !== undefined) add(errors, "$.task.cursorBefore", "is forbidden for maintenance mode");
      if (task.trigger?.type !== "lengthBudget" || !["maxItems", "maxRenderedChars"].includes(task.trigger?.dimension) || !Number.isSafeInteger(task.trigger?.limit) || task.trigger.limit <= 0) add(errors, "$.task.trigger", "must be a valid lengthBudget trigger");
    }
  }
  if (!isPlainObject(envelope.writableState)) add(errors, "$.writableState", "must be an object");
  if (!isPlainObject(envelope.readOnlyContext)) add(errors, "$.readOnlyContext", "must be an object");
  if (!Array.isArray(envelope.observedMessages)) add(errors, "$.observedMessages", "must be an array");
  else if (task?.mode === "maintenance" && envelope.observedMessages.length) add(errors, "$.observedMessages", "must be empty in maintenance mode");
  return { ok: errors.length === 0, errors };
}

module.exports = { validatePatch, validateProposerOutput, validateTaskEnvelope };
