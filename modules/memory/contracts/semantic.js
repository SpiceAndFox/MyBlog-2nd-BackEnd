const {
  TARGETS, TARGET_KEYS, SECTIONS, ITEM_SECTIONS, SCENE_FIELDS,
} = require("./constants");
const { isPlainObject, isIsoTimestamp } = require("./state");
const { validateDueAtExpression } = require("./dueAt");

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NORMAL_RESULT_STATUSES = Object.freeze(["changes", "noop", "unable_to_decide"]);
const COMPACTION_RESULT_STATUSES = Object.freeze(["changes", "unable_to_compact"]);
const COMPILE_ERROR_REASONS = Object.freeze([
  "semantic_schema_invalid",
  "ref_resolution_failed",
  "source_validation_failed",
  "date_anchor_invalid",
  "compile_invariant_failed",
]);

const SECTION_ACTIONS = Object.freeze({
  scene: Object.freeze(["set", "correct", "clear", "forget"]),
  todos: Object.freeze(["add", "update", "correct", "forget", "complete", "cancel", "expire"]),
  standingAgreements: Object.freeze(["add", "update", "correct", "forget", "cancel"]),
  recentEpisodes: Object.freeze(["add", "update", "correct", "forget"]),
  milestones: Object.freeze(["add", "update", "correct", "forget"]),
  worldFacts: Object.freeze(["add", "update", "correct", "forget"]),
  userProfile: Object.freeze(["add", "update", "correct", "forget"]),
  assistantProfile: Object.freeze(["add", "update", "correct", "forget"]),
  relationship: Object.freeze(["add", "update", "correct", "forget"]),
});

const COMPILED_OP_FIELDS = Object.freeze({
  setField: Object.freeze(["op", "path", "value", "sourceRefs"]),
  clearField: Object.freeze(["op", "path", "sourceRefs"]),
  addItem: Object.freeze(["op", "value", "sourceRefs"]),
  updateItem: Object.freeze(["op", "itemId", "value", "sourceRefs"]),
  forgetItem: Object.freeze(["op", "itemId", "sourceRefs"]),
  completeTodo: Object.freeze(["op", "itemId", "sourceRefs"]),
  cancelTodo: Object.freeze(["op", "itemId", "sourceRefs"]),
  expireTodo: Object.freeze(["op", "itemId", "sourceRefs"]),
  cancelAgreement: Object.freeze(["op", "itemId", "sourceRefs"]),
  mergeItems: Object.freeze(["op", "itemIds", "value"]),
});
const SECTION_OPS = Object.freeze({
  scene: Object.freeze(["setField", "clearField"]),
  todos: Object.freeze(["addItem", "updateItem", "forgetItem", "completeTodo", "cancelTodo", "expireTodo", "mergeItems"]),
  standingAgreements: Object.freeze(["addItem", "updateItem", "forgetItem", "cancelAgreement", "mergeItems"]),
  recentEpisodes: Object.freeze(["addItem", "updateItem", "forgetItem"]),
  milestones: Object.freeze(["addItem", "updateItem", "forgetItem", "mergeItems"]),
  worldFacts: Object.freeze(["addItem", "updateItem", "forgetItem", "mergeItems"]),
  userProfile: Object.freeze(["addItem", "updateItem", "forgetItem", "mergeItems"]),
  assistantProfile: Object.freeze(["addItem", "updateItem", "forgetItem", "mergeItems"]),
  relationship: Object.freeze(["addItem", "updateItem", "forgetItem", "mergeItems"]),
});

function add(errors, path, message) { errors.push({ path, message }); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function positiveText(value) { return typeof value === "string" && value.trim().length > 0; }

function checkObject(value, required, optional, path, errors) {
  if (!isPlainObject(value)) { add(errors, path, "must be an object"); return false; }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, `${path}.${key}`, "is not allowed");
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) add(errors, `${path}.${key}`, "is required");
  return true;
}

function sourceRefKey(ref) { return `${ref.messageId}\u0000${ref.contentHash}`; }

function normalizeSourceRefs(refs) {
  const unique = new Map();
  for (const ref of refs || []) {
    if (!ref || !positiveInteger(ref.messageId) || !CONTENT_HASH_PATTERN.test(ref.contentHash || "")) continue;
    unique.set(sourceRefKey(ref), { messageId: ref.messageId, contentHash: ref.contentHash });
  }
  return [...unique.values()].sort((left, right) => (
    left.messageId - right.messageId || left.contentHash.localeCompare(right.contentHash)
  ));
}

function validateSourceRefs(refs, path = "$.sourceRefs", { allowEmpty = false, requireCanonical = true } = {}) {
  const errors = [];
  if (!Array.isArray(refs) || (!allowEmpty && refs.length === 0)) {
    add(errors, path, allowEmpty ? "must be an array" : "must be a non-empty array");
    return { ok: false, errors };
  }
  refs.forEach((ref, index) => {
    const refPath = `${path}[${index}]`;
    if (!checkObject(ref, ["messageId", "contentHash"], [], refPath, errors)) return;
    if (!positiveInteger(ref.messageId)) add(errors, `${refPath}.messageId`, "must be a positive safe integer");
    if (!CONTENT_HASH_PATTERN.test(ref.contentHash || "")) add(errors, `${refPath}.contentHash`, "must be a canonical sha256 content hash");
  });
  if (requireCanonical && errors.length === 0) {
    const normalized = normalizeSourceRefs(refs);
    if (normalized.length !== refs.length || normalized.some((ref, index) => sourceRefKey(ref) !== sourceRefKey(refs[index]))) {
      add(errors, path, "must be unique and sorted by messageId/contentHash");
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateRefEntry(entry, namespace, ref, errors) {
  const path = `$.refMap.${namespace}.${ref}`;
  if (!isPlainObject(entry)) { add(errors, path, "must be an object"); return; }
  if (!SECTIONS.includes(entry.section)) add(errors, `${path}.section`, "is invalid");
  const targetKey = entry.section === "scene" ? "path" : "itemId";
  const required = namespace === "readOnly" ? ["section", targetKey, "sourceRefs"] : ["section", targetKey];
  if (!checkObject(entry, required, [], path, errors)) return;
  if (!positiveText(entry[targetKey])) add(errors, `${path}.${targetKey}`, "must be a non-empty string");
  if (entry.section === "scene" && !SCENE_FIELDS.includes(entry.path)) add(errors, `${path}.path`, "is not a scene field");
  if (namespace === "readOnly") errors.push(...validateSourceRefs(entry.sourceRefs, `${path}.sourceRefs`).errors);
}

function validateRendererArtifact(artifact) {
  const errors = [];
  if (!checkObject(artifact, ["publicInput", "refMap", "messageMeta"], [], "$", errors)) return { ok: false, errors };
  if (checkObject(artifact.publicInput, ["task", "memoryText", "messages"], [], "$.publicInput", errors)) {
    const task = artifact.publicInput.task;
    const taskKeys = ["taskId", "tickId", "proposer", "targetKey", "targetSections", "cursorBefore", "targetMessageId", "now", "userTimeZone"];
    if (checkObject(task, taskKeys, [], "$.publicInput.task", errors)) {
      if (!positiveText(task.taskId)) add(errors, "$.publicInput.task.taskId", "must be a non-empty string");
      if (!nonNegativeInteger(task.tickId)) add(errors, "$.publicInput.task.tickId", "must be a non-negative safe integer");
      if (!TARGET_KEYS.includes(task.targetKey)) add(errors, "$.publicInput.task.targetKey", "is invalid");
      if (TARGETS[task.targetKey]?.proposer !== task.proposer) add(errors, "$.publicInput.task.proposer", "does not match targetKey");
      if (!Array.isArray(task.targetSections) || task.targetSections.join("\u0000") !== (TARGETS[task.targetKey]?.sections || []).join("\u0000")) add(errors, "$.publicInput.task.targetSections", "must exactly match target sections");
      if (!nonNegativeInteger(task.cursorBefore)) add(errors, "$.publicInput.task.cursorBefore", "must be a non-negative safe integer");
      if (!positiveInteger(task.targetMessageId) || task.targetMessageId <= task.cursorBefore) add(errors, "$.publicInput.task.targetMessageId", "must be greater than cursorBefore");
      if (!isIsoTimestamp(task.now)) add(errors, "$.publicInput.task.now", "must be an ISO timestamp");
      if (!positiveText(task.userTimeZone)) add(errors, "$.publicInput.task.userTimeZone", "must be a non-empty string");
    }
    if (typeof artifact.publicInput.memoryText !== "string") add(errors, "$.publicInput.memoryText", "must be a string");
    if (!Array.isArray(artifact.publicInput.messages) || artifact.publicInput.messages.length === 0) add(errors, "$.publicInput.messages", "must be a non-empty array");
    else artifact.publicInput.messages.forEach((message, index) => {
      const path = `$.publicInput.messages[${index}]`;
      if (!checkObject(message, ["id", "role", "createdAt", "content"], [], path, errors)) return;
      if (!positiveInteger(message.id)) add(errors, `${path}.id`, "must be a positive safe integer");
      if (!["user", "assistant"].includes(message.role)) add(errors, `${path}.role`, "must be user or assistant");
      if (!isIsoTimestamp(message.createdAt)) add(errors, `${path}.createdAt`, "must be an ISO timestamp");
      if (typeof message.content !== "string") add(errors, `${path}.content`, "must be a string");
    });
    if (Array.isArray(artifact.publicInput.messages)) {
      const ids = artifact.publicInput.messages.map((message) => message.id);
      if (new Set(ids).size !== ids.length) add(errors, "$.publicInput.messages", "must not contain duplicate message ids");
      if (ids.some((id, index) => index > 0 && id <= ids[index - 1])) add(errors, "$.publicInput.messages", "must be strictly ordered by id");
      const boundary = artifact.publicInput.task?.targetMessageId;
      if (Number.isSafeInteger(boundary) && (!ids.includes(boundary) || ids.some((id) => id > boundary))) add(errors, "$.publicInput.messages", "must end at the captured targetMessageId boundary");
    }
  }
  if (checkObject(artifact.refMap, ["writable", "readOnly"], [], "$.refMap", errors)) {
    for (const namespace of ["writable", "readOnly"]) {
      const map = artifact.refMap[namespace];
      if (!isPlainObject(map)) { add(errors, `$.refMap.${namespace}`, "must be an object"); continue; }
      for (const [ref, entry] of Object.entries(map)) {
        if (!/^[A-Z][A-Z0-9-]*$/.test(ref)) add(errors, `$.refMap.${namespace}.${ref}`, "has an invalid short ref");
        validateRefEntry(entry, namespace, ref, errors);
      }
    }
    const collisions = Object.keys(artifact.refMap.writable || {}).filter((ref) => Object.prototype.hasOwnProperty.call(artifact.refMap.readOnly || {}, ref));
    if (collisions.length) add(errors, "$.refMap", `writable/readOnly refs must not collide: ${collisions.join(", ")}`);
  }
  if (!isPlainObject(artifact.messageMeta)) add(errors, "$.messageMeta", "must be an object");
  else {
    const visibleIds = new Set((artifact.publicInput?.messages || []).map((message) => String(message.id)));
    for (const [id, meta] of Object.entries(artifact.messageMeta)) {
      const path = `$.messageMeta.${id}`;
      if (!visibleIds.has(id)) add(errors, path, "does not identify a rendered message");
      if (!checkObject(meta, ["role", "createdAt", "contentHash"], [], path, errors)) continue;
      if (!["user", "assistant"].includes(meta.role)) add(errors, `${path}.role`, "must be user or assistant");
      if (!isIsoTimestamp(meta.createdAt)) add(errors, `${path}.createdAt`, "must be an ISO timestamp");
      if (!CONTENT_HASH_PATTERN.test(meta.contentHash || "")) add(errors, `${path}.contentHash`, "must be a canonical sha256 content hash");
    }
    for (const id of visibleIds) if (!Object.prototype.hasOwnProperty.call(artifact.messageMeta, id)) add(errors, `$.messageMeta.${id}`, "is required");
    for (const message of artifact.publicInput?.messages || []) {
      const meta = artifact.messageMeta[String(message.id)];
      if (meta && (meta.role !== message.role || new Date(meta.createdAt).toISOString() !== new Date(message.createdAt).toISOString())) {
        add(errors, `$.messageMeta.${message.id}`, "must match rendered message metadata");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateUniqueSelectors(values, path, errors, predicate, message) {
  if (!Array.isArray(values) || values.length === 0) { add(errors, path, "must be a non-empty array when present"); return; }
  values.forEach((value, index) => { if (!predicate(value)) add(errors, `${path}[${index}]`, message); });
  if (new Set(values).size !== values.length) add(errors, path, "must not contain duplicates");
}

function validateDueExpression(value, path, errors) {
  for (const error of validateDueAtExpression(value)) add(errors, `${path}${error.path === "$" ? "" : error.path.slice(1)}`, error.message);
}

function validateDueChange(value, path, errors) {
  if (!isPlainObject(value) || !["keep", "clear", "set"].includes(value.mode)) { add(errors, path, "has invalid mode"); return; }
  if (value.mode === "set") {
    if (!checkObject(value, ["mode", "dueAt"], [], path, errors)) return;
    validateDueExpression(value.dueAt, `${path}.dueAt`, errors);
  } else checkObject(value, ["mode"], [], path, errors);
}

function validateSemanticChange(change, section, path, errors, { maintenance = false } = {}) {
  const commonOptional = ["ref", "text", "evidenceMessageIds", "supportRefs", "actor", "requester", "dueAt", "dueChange", "anchorMessageId", "refs"];
  if (!checkObject(change, ["action"], commonOptional, path, errors)) return;
  if (maintenance) {
    if (change.action !== "merge") add(errors, `${path}.action`, "compaction only permits merge");
    validateUniqueSelectors(change.refs, `${path}.refs`, errors, positiveText, "must be a non-empty short ref");
    if (!positiveText(change.text)) add(errors, `${path}.text`, "must be a non-empty string");
    for (const field of ["ref", "evidenceMessageIds", "supportRefs", "actor", "requester", "dueAt", "dueChange", "anchorMessageId"]) {
      if (change[field] !== undefined) add(errors, `${path}.${field}`, "is not allowed for merge");
    }
    return;
  }
  if (!SECTION_ACTIONS[section]?.includes(change.action)) add(errors, `${path}.action`, `is not allowed for ${section}`);
  if (change.evidenceMessageIds !== undefined) validateUniqueSelectors(change.evidenceMessageIds, `${path}.evidenceMessageIds`, errors, positiveInteger, "must be a positive safe integer");
  if (change.supportRefs !== undefined) validateUniqueSelectors(change.supportRefs, `${path}.supportRefs`, errors, positiveText, "must be a non-empty short ref");
  if (!change.evidenceMessageIds?.length && !change.supportRefs?.length) add(errors, path, "must include evidenceMessageIds or supportRefs");
  if (change.refs !== undefined) add(errors, `${path}.refs`, "is only allowed for merge");

  const addAction = change.action === "add";
  const needsTarget = section === "scene" || !addAction;
  if (needsTarget && !positiveText(change.ref)) add(errors, `${path}.ref`, "is required for this action");
  if (addAction && change.ref !== undefined) add(errors, `${path}.ref`, "is not allowed for add");
  const terminal = ["forget", "clear", "complete", "cancel", "expire"].includes(change.action);
  const needsText = !terminal && !(section === "todos" && ["update", "correct"].includes(change.action));
  if (needsText && !positiveText(change.text)) add(errors, `${path}.text`, "must be a non-empty string");
  if (terminal && change.text !== undefined) add(errors, `${path}.text`, "is not allowed for terminal actions");

  const todoEdit = section === "todos" && ["add", "update", "correct"].includes(change.action);
  for (const field of ["actor", "requester", "dueAt", "dueChange", "anchorMessageId"]) {
    if (!todoEdit && change[field] !== undefined) add(errors, `${path}.${field}`, `is only allowed for todo edits`);
  }
  if (todoEdit) {
    if (change.action === "add") {
      if (!["user", "assistant", "both"].includes(change.actor)) add(errors, `${path}.actor`, "is invalid");
      if (!["user", "assistant"].includes(change.requester)) add(errors, `${path}.requester`, "is invalid");
      if (change.dueAt !== undefined) validateDueExpression(change.dueAt, `${path}.dueAt`, errors);
      if (change.dueChange !== undefined) add(errors, `${path}.dueChange`, "is not allowed for add");
    } else {
      if (change.actor !== undefined && !["user", "assistant", "both"].includes(change.actor)) add(errors, `${path}.actor`, "is invalid");
      if (change.requester !== undefined && !["user", "assistant"].includes(change.requester)) add(errors, `${path}.requester`, "is invalid");
      if (change.dueAt !== undefined) add(errors, `${path}.dueAt`, "is not allowed for update/correct");
      if (change.dueChange === undefined) add(errors, `${path}.dueChange`, "is required for todo update/correct");
      else validateDueChange(change.dueChange, `${path}.dueChange`, errors);
    }
    const relative = change.dueAt?.mode === "relative" || change.dueChange?.dueAt?.mode === "relative";
    if (relative) {
      if (!positiveInteger(change.anchorMessageId)) add(errors, `${path}.anchorMessageId`, "is required for a relative date");
      else if (!change.evidenceMessageIds?.includes(change.anchorMessageId)) add(errors, `${path}.anchorMessageId`, "must belong to evidenceMessageIds");
    } else if (change.anchorMessageId !== undefined) add(errors, `${path}.anchorMessageId`, "is only allowed for a relative date");
  }
}

function validateSemanticResult(result, taskOrArtifact) {
  const task = taskOrArtifact?.publicInput?.task || taskOrArtifact;
  const artifact = taskOrArtifact?.publicInput ? taskOrArtifact : null;
  const errors = [];
  if (!isPlainObject(task) || !TARGET_KEYS.includes(task.targetKey)) return { ok: false, errors: [{ path: "$.task", message: "has invalid targetKey" }] };
  if (!checkObject(result, ["tickId", "proposer", "sectionResults"], [], "$", errors)) return { ok: false, errors };
  if (result.tickId !== task.tickId) add(errors, "$.tickId", "does not match task");
  if (result.proposer !== task.proposer) add(errors, "$.proposer", "does not match task");
  if (!isPlainObject(result.sectionResults)) add(errors, "$.sectionResults", "must be an object");
  else {
    const expected = task.targetSections || TARGETS[task.targetKey].sections;
    const actual = Object.keys(result.sectionResults);
    if (actual.length !== expected.length || expected.some((section) => !actual.includes(section))) add(errors, "$.sectionResults", "must exactly cover targetSections");
    const maintenance = task.proposer === "compactionProposer" || task.mode === "maintenance";
    for (const section of actual) {
      const sectionPath = `$.sectionResults.${section}`;
      const entry = result.sectionResults[section];
      if (!checkObject(entry, ["status"], ["changes"], sectionPath, errors)) continue;
      const statuses = maintenance ? COMPACTION_RESULT_STATUSES : NORMAL_RESULT_STATUSES;
      if (!statuses.includes(entry.status)) add(errors, `${sectionPath}.status`, "is invalid");
      if (entry.status === "changes") {
        if (!Array.isArray(entry.changes) || entry.changes.length === 0) add(errors, `${sectionPath}.changes`, "must be a non-empty array");
        else entry.changes.forEach((change, index) => {
          const changePath = `${sectionPath}.changes[${index}]`;
          validateSemanticChange(change, section, changePath, errors, { maintenance });
          if (!artifact) return;
          for (const id of change.evidenceMessageIds || []) {
            if (!Object.prototype.hasOwnProperty.call(artifact.messageMeta, String(id))) add(errors, `${changePath}.evidenceMessageIds`, `message ${id} was not rendered`);
          }
          for (const ref of change.supportRefs || []) {
            if (!Object.prototype.hasOwnProperty.call(artifact.refMap.readOnly, ref)) add(errors, `${changePath}.supportRefs`, `ref ${ref} was not rendered as read-only Memory`);
          }
        });
      } else if (entry.changes !== undefined) add(errors, `${sectionPath}.changes`, "is only allowed when status is changes");
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateCompiledValue(value, section, op, path, errors) {
  if (op === "setField") { if (!positiveText(value)) add(errors, path, "must be a non-empty string"); return; }
  if (!isPlainObject(value)) { add(errors, path, "must be an object"); return; }
  if (op === "mergeItems" || section !== "todos") {
    if (!checkObject(value, ["text"], [], path, errors)) return;
    if (!positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
    return;
  }
  if (op === "addItem") {
    if (!checkObject(value, ["text", "actor", "requester", "dueAt"], [], path, errors)) return;
    if (!positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
    if (!["user", "assistant", "both"].includes(value.actor)) add(errors, `${path}.actor`, "is invalid");
    if (!["user", "assistant"].includes(value.requester)) add(errors, `${path}.requester`, "is invalid");
    if (value.dueAt !== null && !isIsoTimestamp(value.dueAt)) add(errors, `${path}.dueAt`, "must be null or an ISO timestamp");
    return;
  }
  const allowed = ["text", "actor", "requester", "dueChange"];
  if (!checkObject(value, ["dueChange"], allowed.filter((key) => key !== "dueChange"), path, errors)) return;
  if (value.text !== undefined && !positiveText(value.text)) add(errors, `${path}.text`, "must be a non-empty string");
  if (value.actor !== undefined && !["user", "assistant", "both"].includes(value.actor)) add(errors, `${path}.actor`, "is invalid");
  if (value.requester !== undefined && !["user", "assistant"].includes(value.requester)) add(errors, `${path}.requester`, "is invalid");
  const dueChange = value.dueChange;
  if (!isPlainObject(dueChange) || !["keep", "clear", "set"].includes(dueChange.mode)) add(errors, `${path}.dueChange`, "has invalid mode");
  else if (dueChange.mode === "set") {
    if (checkObject(dueChange, ["mode", "dueAt"], [], `${path}.dueChange`, errors) && !isIsoTimestamp(dueChange.dueAt)) add(errors, `${path}.dueChange.dueAt`, "must be an ISO timestamp");
  } else checkObject(dueChange, ["mode"], [], `${path}.dueChange`, errors);
}

function validateCompiledPatch(patch, section, { maintenance = false } = {}) {
  const errors = [];
  if (!isPlainObject(patch) || !COMPILED_OP_FIELDS[patch.op]) return { ok: false, errors: [{ path: "$.op", message: "is invalid" }] };
  checkObject(patch, COMPILED_OP_FIELDS[patch.op], [], "$", errors);
  if (!SECTIONS.includes(section)) add(errors, "$.section", "is invalid");
  else if (!SECTION_OPS[section].includes(patch.op)) add(errors, "$.op", `is not allowed for ${section}`);
  if (maintenance !== (patch.op === "mergeItems")) add(errors, "$.op", maintenance ? "maintenance only permits mergeItems" : "mergeItems is maintenance-only");
  if (["setField", "clearField"].includes(patch.op)) {
    if (section !== "scene") add(errors, "$.op", "requires scene");
    if (!SCENE_FIELDS.includes(patch.path)) add(errors, "$.path", "is not a scene field");
  } else if (section === "scene") add(errors, "$.op", "is not allowed for scene");
  if (["completeTodo", "cancelTodo", "expireTodo"].includes(patch.op) && section !== "todos") add(errors, "$.op", "requires todos");
  if (patch.op === "cancelAgreement" && section !== "standingAgreements") add(errors, "$.op", "requires standingAgreements");
  if (patch.op === "forgetItem" && !ITEM_SECTIONS.includes(section)) add(errors, "$.op", "requires an item section");
  if (patch.itemId !== undefined && !positiveText(patch.itemId)) add(errors, "$.itemId", "must be a non-empty string");
  if (patch.itemIds !== undefined) {
    if (!Array.isArray(patch.itemIds) || patch.itemIds.length < 2 || patch.itemIds.some((id) => !positiveText(id))) add(errors, "$.itemIds", "must contain at least two item ids");
    else if (new Set(patch.itemIds).size !== patch.itemIds.length) add(errors, "$.itemIds", "must not contain duplicates");
  }
  if (patch.value !== undefined) validateCompiledValue(patch.value, section, patch.op, "$.value", errors);
  if (patch.sourceRefs !== undefined) errors.push(...validateSourceRefs(patch.sourceRefs).errors);
  return { ok: errors.length === 0, errors };
}

function validateCompiledProposal(proposal, task) {
  const errors = [];
  if (!checkObject(proposal, ["tickId", "proposer", "sectionResults"], [], "$", errors)) return { ok: false, errors };
  if (proposal.tickId !== task.tickId) add(errors, "$.tickId", "does not match task");
  if (proposal.proposer !== task.proposer) add(errors, "$.proposer", "does not match task");
  const expected = task.targetSections || TARGETS[task.targetKey]?.sections || [];
  if (!isPlainObject(proposal.sectionResults)) add(errors, "$.sectionResults", "must be an object");
  else {
    const actual = Object.keys(proposal.sectionResults);
    if (actual.length !== expected.length || expected.some((section) => !actual.includes(section))) add(errors, "$.sectionResults", "must exactly cover targetSections");
    const maintenance = task.proposer === "compactionProposer" || task.mode === "maintenance";
    for (const section of actual) {
      const path = `$.sectionResults.${section}`;
      const result = proposal.sectionResults[section];
      if (!checkObject(result, ["status"], ["patches"], path, errors)) continue;
      if (!["patches", "noop"].includes(result.status)) add(errors, `${path}.status`, "is invalid");
      if (result.status === "patches") {
        if (!Array.isArray(result.patches) || result.patches.length === 0) add(errors, `${path}.patches`, "must be a non-empty array");
        else result.patches.forEach((patch, index) => {
          for (const error of validateCompiledPatch(patch, section, { maintenance }).errors) add(errors, `${path}.patches[${index}]${error.path.slice(1)}`, error.message);
        });
      } else if (result.patches !== undefined) add(errors, `${path}.patches`, "is only allowed when status is patches");
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CONTENT_HASH_PATTERN,
  NORMAL_RESULT_STATUSES,
  COMPACTION_RESULT_STATUSES,
  COMPILE_ERROR_REASONS,
  SECTION_ACTIONS,
  COMPILED_OP_FIELDS,
  SECTION_OPS,
  sourceRefKey,
  normalizeSourceRefs,
  validateSourceRefs,
  validateRendererArtifact,
  validateSemanticResult,
  validateCompiledPatch,
  validateCompiledProposal,
};
