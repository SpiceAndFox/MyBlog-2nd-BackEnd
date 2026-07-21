const { TARGET_KEYS, SCENE_FIELDS, ITEM_SECTIONS } = require("./constants");
const { isPlainObject, isIsoTimestamp } = require("./state");
const { validateSourceRefs } = require("./semantic");

const MEMORY_CONTROL_V201_SCHEMA_VERSION = "2.01";

function createEmptySceneV201() {
  return Object.fromEntries(SCENE_FIELDS.map((field) => [field, {
    value: null,
    sourceRefs: [],
    updatedAtMessageId: null,
  }]));
}

function createInitialMemoryStateV201() {
  return {
    version: MEMORY_CONTROL_V201_SCHEMA_VERSION,
    current: { scene: createEmptySceneV201(), previousScene: null },
    working: { todos: [], standingAgreements: [], recentEpisodes: [] },
    longTerm: { milestones: [], worldFacts: [], userProfile: [], assistantProfile: [], relationship: [] },
    meta: { revision: 0, sourceGeneration: 0, targetCursors: {} },
  };
}

function add(errors, path, message) { errors.push({ path, message }); }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }

function exactObject(value, keys, path, errors) {
  if (!isPlainObject(value)) { add(errors, path, "must be an object"); return false; }
  for (const key of Object.keys(value)) if (!keys.includes(key)) add(errors, `${path}.${key}`, "is not allowed");
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) add(errors, `${path}.${key}`, "is required");
  return true;
}

function sourceErrors(refs, path, errors, options) {
  for (const error of validateSourceRefs(refs, path, options).errors) errors.push(error);
}

function validateSceneFieldV201(field, path, errors) {
  if (!exactObject(field, ["value", "sourceRefs", "updatedAtMessageId"], path, errors)) return;
  if (field.value !== null && typeof field.value !== "string") add(errors, `${path}.value`, "must be null or a string");
  if (field.value === null) {
    sourceErrors(field.sourceRefs, `${path}.sourceRefs`, errors, { allowEmpty: true });
    if (field.sourceRefs?.length || field.updatedAtMessageId !== null) add(errors, path, "empty field must clear provenance");
    return;
  }
  sourceErrors(field.sourceRefs, `${path}.sourceRefs`, errors);
  const newest = Array.isArray(field.sourceRefs) && field.sourceRefs.length ? Math.max(...field.sourceRefs.map((ref) => ref.messageId)) : null;
  if (field.updatedAtMessageId !== newest) add(errors, `${path}.updatedAtMessageId`, "must equal the newest source message id");
}

function validateItemV201(item, section, path, errors) {
  const common = ["id", "text", "sourceRefs", "createdAtMessageId", "updatedAtMessageId"];
  const keys = section === "todos" ? [...common, "actor", "requester", "status", "becameOverdueAt", "dueAt"] : common;
  if (!exactObject(item, keys, path, errors)) return;
  if (typeof item.id !== "string" || !item.id.trim()) add(errors, `${path}.id`, "must be a non-empty string");
  if (typeof item.text !== "string" || !item.text.trim()) add(errors, `${path}.text`, "must be a non-empty string");
  sourceErrors(item.sourceRefs, `${path}.sourceRefs`, errors);
  const ids = Array.isArray(item.sourceRefs) ? item.sourceRefs.map((ref) => ref.messageId).filter(nonNegativeInteger) : [];
  if (!nonNegativeInteger(item.createdAtMessageId) || (ids.length && !ids.includes(item.createdAtMessageId))) add(errors, `${path}.createdAtMessageId`, "must identify persisted creation provenance");
  if (!nonNegativeInteger(item.updatedAtMessageId) || (ids.length && item.updatedAtMessageId !== Math.max(...ids))) add(errors, `${path}.updatedAtMessageId`, "must equal the newest source message id");
  if (section !== "todos") return;
  if (!["user", "assistant", "both"].includes(item.actor)) add(errors, `${path}.actor`, "is invalid");
  if (!["user", "assistant"].includes(item.requester)) add(errors, `${path}.requester`, "is invalid");
  if (!["active", "overdue"].includes(item.status)) add(errors, `${path}.status`, "is invalid");
  if (item.dueAt !== null && !isIsoTimestamp(item.dueAt)) add(errors, `${path}.dueAt`, "must be null or an ISO timestamp");
  if (item.becameOverdueAt !== null && !isIsoTimestamp(item.becameOverdueAt)) add(errors, `${path}.becameOverdueAt`, "must be null or an ISO timestamp");
  if (item.status === "active" && item.becameOverdueAt !== null) add(errors, `${path}.becameOverdueAt`, "must be null for active todos");
  if (item.status === "overdue" && (item.dueAt === null || item.becameOverdueAt !== item.dueAt)) add(errors, path, "overdue todos require matching dueAt/becameOverdueAt");
}

function validateMemoryStateV201(value) {
  const errors = [];
  if (!exactObject(value, ["version", "current", "working", "longTerm", "meta"], "$", errors)) return { ok: false, errors };
  if (value.version !== MEMORY_CONTROL_V201_SCHEMA_VERSION) add(errors, "$.version", `must equal ${MEMORY_CONTROL_V201_SCHEMA_VERSION}`);
  if (exactObject(value.current, ["scene", "previousScene"], "$.current", errors)) {
    if (exactObject(value.current.scene, SCENE_FIELDS, "$.current.scene", errors)) {
      for (const field of SCENE_FIELDS) validateSceneFieldV201(value.current.scene[field], `$.current.scene.${field}`, errors);
    }
    if (value.current.previousScene !== null) {
      if (exactObject(value.current.previousScene, [...SCENE_FIELDS, "expiredAt"], "$.current.previousScene", errors)) {
        for (const field of SCENE_FIELDS) validateSceneFieldV201(value.current.previousScene[field], `$.current.previousScene.${field}`, errors);
        if (!isIsoTimestamp(value.current.previousScene.expiredAt)) add(errors, "$.current.previousScene.expiredAt", "must be an ISO timestamp");
      }
    }
  }
  const containers = [
    [value.working, ["todos", "standingAgreements", "recentEpisodes"], "$.working"],
    [value.longTerm, ["milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"], "$.longTerm"],
  ];
  const ids = [];
  for (const [container, sections, path] of containers) {
    if (!exactObject(container, sections, path, errors)) continue;
    for (const section of sections) {
      if (!Array.isArray(container[section])) { add(errors, `${path}.${section}`, "must be an array"); continue; }
      container[section].forEach((item, index) => {
        validateItemV201(item, section, `${path}.${section}[${index}]`, errors);
        if (typeof item?.id === "string") ids.push(item.id);
      });
    }
  }
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) add(errors, "$", `item ids must be globally unique: ${duplicates.join(", ")}`);
  if (exactObject(value.meta, ["revision", "sourceGeneration", "targetCursors"], "$.meta", errors)) {
    if (!nonNegativeInteger(value.meta.revision)) add(errors, "$.meta.revision", "must be a non-negative safe integer");
    if (!nonNegativeInteger(value.meta.sourceGeneration)) add(errors, "$.meta.sourceGeneration", "must be a non-negative safe integer");
    if (!isPlainObject(value.meta.targetCursors)) add(errors, "$.meta.targetCursors", "must be an object");
    else for (const [key, cursor] of Object.entries(value.meta.targetCursors)) {
      if (!TARGET_KEYS.includes(key)) add(errors, `$.meta.targetCursors.${key}`, "is not a target key");
      if (!nonNegativeInteger(cursor)) add(errors, `$.meta.targetCursors.${key}`, "must be a non-negative safe integer");
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertMemoryStateV201(value) {
  const validation = validateMemoryStateV201(value);
  if (!validation.ok) {
    const error = new Error(`Invalid Memory 2.01 state: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_V201_STATE_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return value;
}

module.exports = {
  MEMORY_CONTROL_V201_SCHEMA_VERSION,
  createEmptySceneV201,
  createInitialMemoryStateV201,
  validateMemoryStateV201,
  assertMemoryStateV201,
};
