const crypto = require("node:crypto");
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
  ITEM_SECTIONS,
  READ_ONLY_CONTEXT_PATHS,
} = require("./constants");
const { isValidIanaTimeZone } = require("../../../utils/timeZone");
const { isPlainObject, isIsoTimestamp } = require("./state");
const { validateDueAtExpression } = require("./dueAt");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

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
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function validateDueAt(value, path, errors) {
  for (const error of validateDueAtExpression(value)) {
    add(errors, `${path}${error.path.slice(1)}`, error.message);
  }
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
    if (section === "scene" && Array.isArray(patch.evidenceRefs) && patch.evidenceRefs.length !== 1) {
      add(errors, "$.evidenceRefs", "scene operations require exactly one ref");
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateProposerOutput(output, task) {
  const errors = [];
  if (!isPlainObject(task) || !TARGET_KEYS.includes(task.targetKey)) return { ok: false, errors: [{ path: "$.task", message: "has invalid targetKey" }] };
  const maintenance = task.mode === "maintenance";
  const expectedProposer = maintenance ? "compactionProposer" : TARGETS[task.targetKey].proposer;
  const expectedSections = maintenance ? task.targetSections : TARGETS[task.targetKey].sections;
  if (!exactObject(output, ["tickId", "proposer", "sectionResults"], "$", errors)) return { ok: false, errors };
  if (!nonNegativeInteger(output.tickId)) add(errors, "$.tickId", "must be a non-negative safe integer");
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

function expectedTree(paths) {
  const tree = {};
  for (const path of paths) {
    const [container, section] = path.split(".");
    tree[container] ||= [];
    tree[container].push(section);
  }
  return tree;
}

function validateRedactedScene(scene, path, errors) {
  if (!exactObject(scene, SCENE_FIELDS, path, errors)) return;
  for (const fieldName of SCENE_FIELDS) {
    const fieldPath = `${path}.${fieldName}`;
    const field = scene[fieldName];
    if (!exactObject(field, ["value", "updatedAtMessageId"], fieldPath, errors)) continue;
    if (field.value !== null && typeof field.value !== "string") add(errors, `${fieldPath}.value`, "must be null or a string");
    if (field.updatedAtMessageId !== null && !nonNegativeInteger(field.updatedAtMessageId)) add(errors, `${fieldPath}.updatedAtMessageId`, "must be null or a non-negative safe integer");
    if ((field.value === null) !== (field.updatedAtMessageId === null)) add(errors, fieldPath, "value and updatedAtMessageId must both be null or both be populated");
  }
}

function validateRedactedItem(item, section, writable, path, errors, { maintenance = false } = {}) {
  const baseKeys = writable
    ? ["text", "createdAtMessageId", "updatedAtMessageId", "id"]
    : ["text", "createdAtMessageId", "updatedAtMessageId"];
  const keys = section === "todos"
    ? [...baseKeys, "actor", "requester", "status", "becameOverdueAt", "dueAt"]
    : baseKeys;
  if (!exactObject(item, keys, path, errors)) return;
  if (writable && !positiveText(item.id)) add(errors, `${path}.id`, "must be a non-empty string");
  if (!positiveText(item.text)) add(errors, `${path}.text`, "must be a non-empty string");
  if (!nonNegativeInteger(item.createdAtMessageId)) add(errors, `${path}.createdAtMessageId`, "must be a non-negative safe integer");
  if (!nonNegativeInteger(item.updatedAtMessageId)) add(errors, `${path}.updatedAtMessageId`, "must be a non-negative safe integer");
  if (section !== "todos") return;
  if (!["user", "assistant", "both"].includes(item.actor)) add(errors, `${path}.actor`, "is invalid");
  if (!["user", "assistant"].includes(item.requester)) add(errors, `${path}.requester`, "is invalid");
  if (!["active", "overdue"].includes(item.status)) add(errors, `${path}.status`, "is invalid");
  if (item.dueAt !== null && !isIsoTimestamp(item.dueAt)) add(errors, `${path}.dueAt`, "must be null or an ISO 8601 timestamp");
  if (item.becameOverdueAt !== null && !isIsoTimestamp(item.becameOverdueAt)) add(errors, `${path}.becameOverdueAt`, "must be null or an ISO 8601 timestamp");
  if (item.status === "active" && item.becameOverdueAt !== null) add(errors, `${path}.becameOverdueAt`, "must be null for active todos");
  if (item.status === "overdue" && (item.dueAt === null || item.becameOverdueAt === null)) add(errors, path, "overdue todos require dueAt and becameOverdueAt");
  if (!writable && item.status !== "active") add(errors, `${path}.status`, "read-only todo context only permits active items");
  if (maintenance && item.status !== "active") add(errors, `${path}.status`, "todo compaction only permits active items");
}

function validateStateView(view, paths, writable, path, errors, options = {}) {
  const tree = expectedTree(paths);
  if (!exactObject(view, Object.keys(tree), path, errors)) return;
  for (const [container, sections] of Object.entries(tree)) {
    const containerPath = `${path}.${container}`;
    if (!exactObject(view[container], sections, containerPath, errors)) continue;
    for (const section of sections) {
      const sectionPath = `${containerPath}.${section}`;
      const value = view[container][section];
      if (section === "scene") validateRedactedScene(value, sectionPath, errors);
      else if (!Array.isArray(value)) add(errors, sectionPath, "must be an array");
      else value.forEach((item, index) => validateRedactedItem(item, section, writable, `${sectionPath}[${index}]`, errors, options));
    }
  }
}

function validateObservedMessage(message, path, errors) {
  if (!exactObject(message, ["id", "role", "createdAt", "contentKind", "content", "contentHash"], path, errors)) return;
  if (!positiveInteger(message.id)) add(errors, `${path}.id`, "must be a positive safe integer");
  if (!["user", "assistant"].includes(message.role)) add(errors, `${path}.role`, "must be user or assistant");
  if (!isIsoTimestamp(message.createdAt)) add(errors, `${path}.createdAt`, "must be an ISO 8601 timestamp");
  if (message.contentKind !== "raw") add(errors, `${path}.contentKind`, "must be raw");
  if (typeof message.content !== "string") add(errors, `${path}.content`, "must be a string");
  if (!CONTENT_HASH_PATTERN.test(message.contentHash)) add(errors, `${path}.contentHash`, "must be a canonical sha256 content hash");
  else if (typeof message.content === "string") {
    const expected = `sha256:${crypto.createHash("sha256").update(message.content, "utf8").digest("hex")}`;
    if (message.contentHash !== expected) add(errors, `${path}.contentHash`, "does not match raw content");
  }
}

function validateTaskEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  exactObject(envelope, ["task", "writableState", "readOnlyContext", "observedMessages"], "$", errors);
  const task = envelope.task;
  if (!isPlainObject(task)) add(errors, "$.task", "must be an object");
  else {
    const maintenance = task.mode === "maintenance";
    const normalKeys = ["taskId", "tickId", "userId", "presetId", "schemaVersion", "sourceGeneration", "baseRevision", "targetKey", "cursorBefore", "targetMessageId", "proposer", "mode", "targetSections", "observedMessageIds", "trigger", "now", "userTimeZone"];
    const maintenanceKeys = normalKeys.filter((key) => key !== "cursorBefore").concat(["parentTaskId", "resumeEpoch"]);
    exactObject(task, maintenance ? maintenanceKeys : normalKeys, "$.task", errors);
    if (!UUID_PATTERN.test(task.taskId)) add(errors, "$.task.taskId", "must be a UUID");
    if (!nonNegativeInteger(task.tickId)) add(errors, "$.task.tickId", "must be a non-negative safe integer");
    if (!positiveInteger(task.userId)) add(errors, "$.task.userId", "must be a positive safe integer");
    if (!positiveText(task.presetId)) add(errors, "$.task.presetId", "must be a non-empty string");
    if (task.schemaVersion !== SCHEMA_VERSION) add(errors, "$.task.schemaVersion", `must equal ${SCHEMA_VERSION}`);
    if (!TARGET_KEYS.includes(task.targetKey)) add(errors, "$.task.targetKey", "is invalid");
    if (!["normal", "maintenance"].includes(task.mode)) add(errors, "$.task.mode", "is invalid");
    if (!nonNegativeInteger(task.baseRevision)) add(errors, "$.task.baseRevision", "must be a non-negative safe integer");
    if (!nonNegativeInteger(task.sourceGeneration)) add(errors, "$.task.sourceGeneration", "must be a non-negative safe integer");
    if (!isValidIanaTimeZone(task.userTimeZone)) add(errors, "$.task.userTimeZone", "must be a valid IANA time zone");
    if (!isIsoTimestamp(task.now)) add(errors, "$.task.now", "must be an ISO 8601 timestamp");
    if (!positiveInteger(task.targetMessageId)) add(errors, "$.task.targetMessageId", "must be a positive safe integer");
    if (!Array.isArray(task.targetSections) || task.targetSections.some((section) => !SECTIONS.includes(section))) add(errors, "$.task.targetSections", "is invalid");
    if (!Array.isArray(task.observedMessageIds) || task.observedMessageIds.some((id) => !positiveInteger(id))) add(errors, "$.task.observedMessageIds", "must contain positive safe integers");
    if (task.mode === "normal") {
      if (!nonNegativeInteger(task.cursorBefore)) add(errors, "$.task.cursorBefore", "is required for normal mode");
      if (isPlainObject(task.trigger)) exactObject(task.trigger, ["type"], "$.task.trigger", errors);
      if (!["lagThreshold", "forceDrain"].includes(task.trigger?.type)) add(errors, "$.task.trigger", "must be lagThreshold or forceDrain for normal mode");
      const definition = TARGETS[task.targetKey];
      if (definition && task.proposer !== definition.proposer) add(errors, "$.task.proposer", `must equal ${definition.proposer}`);
      if (definition && JSON.stringify(task.targetSections) !== JSON.stringify(definition.sections)) add(errors, "$.task.targetSections", "must exactly match target sections");
      if (nonNegativeInteger(task.cursorBefore) && positiveInteger(task.targetMessageId) && task.targetMessageId <= task.cursorBefore) add(errors, "$.task.targetMessageId", "must be greater than cursorBefore");
    } else {
      if (task.proposer !== "compactionProposer") add(errors, "$.task.proposer", "must be compactionProposer for maintenance mode");
      if (!UUID_PATTERN.test(task.parentTaskId)) add(errors, "$.task.parentTaskId", "must be a UUID");
      if (!nonNegativeInteger(task.resumeEpoch)) add(errors, "$.task.resumeEpoch", "must be a non-negative safe integer");
      if (!Array.isArray(task.targetSections) || task.targetSections.length !== 1 || !ITEM_SECTIONS.includes(task.targetSections[0]) || task.targetSections[0] === "recentEpisodes") add(errors, "$.task.targetSections", "maintenance requires one compactable item section");
      if (TARGETS[task.targetKey] && !TARGETS[task.targetKey].sections.includes(task.targetSections?.[0])) add(errors, "$.task.targetSections", "must belong to targetKey");
      if (task.trigger?.type !== "lengthBudget" || !["maxItems", "maxRenderedChars"].includes(task.trigger?.dimension) || !Number.isSafeInteger(task.trigger?.limit) || task.trigger.limit <= 0) add(errors, "$.task.trigger", "must be a valid lengthBudget trigger");
      else exactObject(task.trigger, ["type", "dimension", "limit"], "$.task.trigger", errors);
    }
  }
  if (isPlainObject(task) && TARGET_KEYS.includes(task.targetKey) && Array.isArray(task.targetSections)) {
    validateStateView(envelope.writableState, task.targetSections.map((section) => section === "scene" ? "current.scene" : (["todos", "standingAgreements", "recentEpisodes"].includes(section) ? `working.${section}` : `longTerm.${section}`)), true, "$.writableState", errors, { maintenance: task.mode === "maintenance" });
    validateStateView(envelope.readOnlyContext, READ_ONLY_CONTEXT_PATHS[task.proposer] || [], false, "$.readOnlyContext", errors);
  } else {
    if (!isPlainObject(envelope.writableState)) add(errors, "$.writableState", "must be an object");
    if (!isPlainObject(envelope.readOnlyContext)) add(errors, "$.readOnlyContext", "must be an object");
  }
  if (!Array.isArray(envelope.observedMessages)) add(errors, "$.observedMessages", "must be an array");
  else {
    envelope.observedMessages.forEach((message, index) => validateObservedMessage(message, `$.observedMessages[${index}]`, errors));
    if (task?.mode === "maintenance") {
      if (envelope.observedMessages.length) add(errors, "$.observedMessages", "must be empty in maintenance mode");
      if (Array.isArray(task.observedMessageIds) && task.observedMessageIds.length) add(errors, "$.task.observedMessageIds", "must be empty in maintenance mode");
    } else if (task?.mode === "normal") {
      if (!envelope.observedMessages.length) add(errors, "$.observedMessages", "must be non-empty in normal mode");
      const ids = envelope.observedMessages.map((message) => message?.id);
      if (JSON.stringify(ids) !== JSON.stringify(task.observedMessageIds)) add(errors, "$.task.observedMessageIds", "must exactly match observedMessages ids");
      if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= ids[index - 1])) add(errors, "$.observedMessages", "ids must be unique and strictly increasing");
      if (!ids.includes(task.targetMessageId)) add(errors, "$.task.targetMessageId", "must be present in observedMessages");
      if (ids.some((id) => id > task.targetMessageId)) add(errors, "$.observedMessages", "cannot contain messages after targetMessageId");
      if (!ids.some((id) => id > task.cursorBefore)) add(errors, "$.observedMessages", "must contain a new batch after cursorBefore");
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validatePatch, validateProposerOutput, validateTaskEnvelope };
