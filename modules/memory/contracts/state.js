const {
  SCHEMA_VERSION, TARGET_KEYS, SCENE_FIELDS, ITEM_SECTIONS, EVIDENCE_KINDS,
  SECTION_EVIDENCE_KINDS, QUOTE_MAX_CODE_POINTS,
} = require("./constants");

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function createEmptyScene() {
  return Object.fromEntries(
    SCENE_FIELDS.map((field) => [field, { value: null, evidenceRef: null, updatedAtMessageId: null }])
  );
}

function createInitialMemoryState() {
  return {
    version: SCHEMA_VERSION,
    current: { scene: createEmptyScene(), previousScene: null },
    working: { todos: [], standingAgreements: [], recentEpisodes: [] },
    longTerm: { milestones: [], worldFacts: [], userProfile: [], assistantProfile: [], relationship: [] },
    meta: { revision: 0, sourceGeneration: 0, targetCursors: {} },
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function exactKeys(value, allowed, path, errors) {
  if (!isPlainObject(value)) {
    push(errors, path, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) push(errors, `${path}.${key}`, "is not allowed");
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) push(errors, `${path}.${key}`, "is required");
  }
  return true;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function validateEvidenceRef(ref, path, errors, { persisted = true } = {}) {
  const keys = persisted ? ["messageId", "contentHash", "quote"] : ["messageId", "quote"];
  if (!exactKeys(ref, keys, path, errors)) return;
  if (!nonNegativeInteger(ref.messageId)) push(errors, `${path}.messageId`, "must be a non-negative safe integer");
  if (persisted && !CONTENT_HASH_PATTERN.test(ref.contentHash)) {
    push(errors, `${path}.contentHash`, "must be sha256: followed by 64 lowercase hexadecimal characters");
  }
  if (typeof ref.quote !== "string" || !ref.quote.trim()) push(errors, `${path}.quote`, "must be a non-empty string");
  else if (Array.from(ref.quote).length > QUOTE_MAX_CODE_POINTS) push(errors, `${path}.quote`, `must not exceed ${QUOTE_MAX_CODE_POINTS} code points`);
}

function validateEvidenceGroups(groups, section, path, errors) {
  if (!Array.isArray(groups) || groups.length === 0) {
    push(errors, path, "must be a non-empty array");
    return;
  }
  groups.forEach((group, groupIndex) => {
    const groupPath = `${path}[${groupIndex}]`;
    if (!exactKeys(group, ["evidenceKind", "refs"], groupPath, errors)) return;
    if (!EVIDENCE_KINDS.includes(group.evidenceKind)) push(errors, `${groupPath}.evidenceKind`, "is invalid");
    else if (!SECTION_EVIDENCE_KINDS[section]?.includes(group.evidenceKind)) push(errors, `${groupPath}.evidenceKind`, `cannot be persisted in ${section}`);
    if (!Array.isArray(group.refs) || group.refs.length === 0) push(errors, `${groupPath}.refs`, "must be a non-empty array");
    else group.refs.forEach((ref, index) => validateEvidenceRef(ref, `${groupPath}.refs[${index}]`, errors));
  });
}

function validateItem(item, section, path, errors) {
  const todoKeys = [
    "id", "text", "evidenceGroups", "createdAtMessageId", "updatedAtMessageId",
    "actor", "requester", "status", "becameOverdueAt", "dueAt",
  ];
  const keys = section === "todos" ? todoKeys : todoKeys.slice(0, 5);
  if (!exactKeys(item, keys, path, errors)) return;
  if (typeof item.id !== "string" || !item.id.trim()) push(errors, `${path}.id`, "must be a non-empty string");
  if (typeof item.text !== "string" || !item.text.trim()) push(errors, `${path}.text`, "must be a non-empty string");
  validateEvidenceGroups(item.evidenceGroups, section, `${path}.evidenceGroups`, errors);
  if (!nonNegativeInteger(item.createdAtMessageId)) push(errors, `${path}.createdAtMessageId`, "must be a non-negative safe integer");
  if (!nonNegativeInteger(item.updatedAtMessageId)) push(errors, `${path}.updatedAtMessageId`, "must be a non-negative safe integer");
  if (nonNegativeInteger(item.createdAtMessageId) && nonNegativeInteger(item.updatedAtMessageId) && item.updatedAtMessageId < item.createdAtMessageId) {
    push(errors, `${path}.updatedAtMessageId`, "cannot precede createdAtMessageId");
  }
  const evidenceMessageIds = Array.isArray(item.evidenceGroups)
    ? item.evidenceGroups.flatMap((group) => Array.isArray(group?.refs) ? group.refs.map((ref) => ref?.messageId).filter(nonNegativeInteger) : [])
    : [];
  if (evidenceMessageIds.length) {
    if (!evidenceMessageIds.includes(item.createdAtMessageId)) push(errors, `${path}.createdAtMessageId`, "must identify persisted creation evidence");
    if (item.updatedAtMessageId !== Math.max(...evidenceMessageIds)) push(errors, `${path}.updatedAtMessageId`, "must equal the newest evidence message id");
  }
  if (section !== "todos") return;
  if (!["user", "assistant", "both"].includes(item.actor)) push(errors, `${path}.actor`, "is invalid");
  if (!["user", "assistant"].includes(item.requester)) push(errors, `${path}.requester`, "is invalid");
  if (!["active", "overdue"].includes(item.status)) push(errors, `${path}.status`, "is invalid");
  if (item.dueAt !== null && !isIsoTimestamp(item.dueAt)) push(errors, `${path}.dueAt`, "must be null or an ISO 8601 timestamp");
  if (item.becameOverdueAt !== null && !isIsoTimestamp(item.becameOverdueAt)) push(errors, `${path}.becameOverdueAt`, "must be null or an ISO 8601 timestamp");
  if (item.status === "active" && item.becameOverdueAt !== null) push(errors, `${path}.becameOverdueAt`, "must be null for active todos");
  if (item.status === "overdue" && item.becameOverdueAt === null) push(errors, `${path}.becameOverdueAt`, "is required for overdue todos");
  if (item.status === "overdue" && item.dueAt === null) push(errors, `${path}.dueAt`, "is required for overdue todos");
  if (item.status === "overdue" && isIsoTimestamp(item.dueAt) && isIsoTimestamp(item.becameOverdueAt) && item.dueAt !== item.becameOverdueAt) {
    push(errors, `${path}.becameOverdueAt`, "must equal dueAt for overdue todos");
  }
}

function validateSceneField(field, path, errors) {
  if (!exactKeys(field, ["value", "evidenceRef", "updatedAtMessageId"], path, errors)) return;
  if (field.value !== null && typeof field.value !== "string") push(errors, `${path}.value`, "must be null or a string");
  if (field.value === null) {
    if (field.evidenceRef !== null || field.updatedAtMessageId !== null) push(errors, path, "empty field must clear provenance");
    return;
  }
  if (field.evidenceRef === null) push(errors, `${path}.evidenceRef`, "is required for a populated field");
  else {
    validateEvidenceRef(field.evidenceRef, `${path}.evidenceRef`, errors);
    if (field.updatedAtMessageId !== field.evidenceRef.messageId) push(errors, `${path}.updatedAtMessageId`, "must equal evidenceRef.messageId");
  }
  if (!nonNegativeInteger(field.updatedAtMessageId)) push(errors, `${path}.updatedAtMessageId`, "must be a non-negative safe integer");
}

function validateMemoryStateV2(value) {
  const errors = [];
  if (!exactKeys(value, ["version", "current", "working", "longTerm", "meta"], "$", errors)) return { ok: false, errors };
  if (value.version !== SCHEMA_VERSION) push(errors, "$.version", `must equal ${SCHEMA_VERSION}`);

  if (exactKeys(value.current, ["scene", "previousScene"], "$.current", errors)) {
    if (exactKeys(value.current.scene, SCENE_FIELDS, "$.current.scene", errors)) {
      SCENE_FIELDS.forEach((name) => validateSceneField(value.current.scene[name], `$.current.scene.${name}`, errors));
    }
    if (value.current.previousScene !== null) {
      const previousKeys = [...SCENE_FIELDS, "expiredAt"];
      if (exactKeys(value.current.previousScene, previousKeys, "$.current.previousScene", errors)) {
        SCENE_FIELDS.forEach((name) => validateSceneField(value.current.previousScene[name], `$.current.previousScene.${name}`, errors));
        if (!isIsoTimestamp(value.current.previousScene.expiredAt)) push(errors, "$.current.previousScene.expiredAt", "must be an ISO 8601 timestamp");
      }
    }
  }

  const containers = [
    [value.working, ["todos", "standingAgreements", "recentEpisodes"], "$.working"],
    [value.longTerm, ["milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"], "$.longTerm"],
  ];
  for (const [container, keys, path] of containers) {
    if (!exactKeys(container, keys, path, errors)) continue;
    keys.forEach((section) => {
      if (!Array.isArray(container[section])) push(errors, `${path}.${section}`, "must be an array");
      else container[section].forEach((item, index) => validateItem(item, section, `${path}.${section}[${index}]`, errors));
    });
  }

  if (exactKeys(value.meta, ["revision", "sourceGeneration", "targetCursors"], "$.meta", errors)) {
    if (!nonNegativeInteger(value.meta.revision)) push(errors, "$.meta.revision", "must be a non-negative safe integer");
    if (!nonNegativeInteger(value.meta.sourceGeneration)) push(errors, "$.meta.sourceGeneration", "must be a non-negative safe integer");
    if (!isPlainObject(value.meta.targetCursors)) push(errors, "$.meta.targetCursors", "must be an object");
    else for (const [key, cursor] of Object.entries(value.meta.targetCursors)) {
      if (!TARGET_KEYS.includes(key)) push(errors, `$.meta.targetCursors.${key}`, "is not a target key");
      if (!nonNegativeInteger(cursor)) push(errors, `$.meta.targetCursors.${key}`, "must be a non-negative safe integer");
    }
  }

  const ids = [];
  for (const section of ITEM_SECTIONS) {
    const container = ["todos", "standingAgreements", "recentEpisodes"].includes(section) ? value.working : value.longTerm;
    if (Array.isArray(container?.[section])) container[section].forEach((item) => ids.push(item?.id));
  }
  const duplicates = ids.filter((id, index) => typeof id === "string" && ids.indexOf(id) !== index);
  if (duplicates.length) push(errors, "$", `item ids must be globally unique: ${[...new Set(duplicates)].join(", ")}`);
  return { ok: errors.length === 0, errors };
}

function assertMemoryState(value) {
  const result = validateMemoryState(value);
  if (!result.ok) {
    const error = new Error(`Invalid Memory v2 state: ${result.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_V2_STATE_INVALID";
    error.validationErrors = result.errors;
    throw error;
  }
  return value;
}

const MEMORY_STATE_SCHEMA_HOLDERS = Object.freeze({
  [SCHEMA_VERSION]: Object.freeze({ version: SCHEMA_VERSION, validate: validateMemoryStateV2 }),
});

function getMemoryStateSchemaHolder(version) {
  return MEMORY_STATE_SCHEMA_HOLDERS[version] || null;
}

function validateMemoryState(value) {
  if (!isPlainObject(value)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  const holder = getMemoryStateSchemaHolder(value.version);
  if (!holder) return { ok: false, errors: [{ path: "$.version", message: `unsupported Memory state schema version: ${value.version ?? "<missing>"}` }] };
  return holder.validate(value);
}

function migrateMemoryState(value, targetVersion = SCHEMA_VERSION) {
  if (value?.version === targetVersion) return assertMemoryState(value);
  const error = new Error(`No explicit Memory state migration from version ${value?.version ?? "<missing>"} to ${targetVersion}`);
  error.code = "MEMORY_V2_MIGRATION_REQUIRED";
  throw error;
}

module.exports = {
  createEmptyScene, createInitialMemoryState, validateMemoryState, assertMemoryState, isPlainObject,
  isIsoTimestamp, getMemoryStateSchemaHolder, migrateMemoryState, MEMORY_STATE_SCHEMA_HOLDERS,
};
