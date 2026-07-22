const { isDeepStrictEqual } = require("node:util");
const { assertMemoryState, createEmptyScene } = require("../contracts/state");
const {
  MEMORY_CONTROL_V201_SCHEMA_VERSION,
  assertMemoryStateV201,
  createEmptySceneV201,
  validateSourceRefs,
} = require("../contracts");
const { SCHEMA_VERSION, PATCH_OPS, SCENE_FIELDS, TARGETS, EVIDENCE_KINDS } = require("../contracts/constants");
const { sectionItems } = require("./reducer");

const DECISIONS = new Set(["accepted", "rejected", "noop", "system_cleanup"]);
const GROUP_KINDS = new Set(["proposal", "maintenance", "system_cleanup"]);
const ITEM_SECTIONS = new Set(Object.values(TARGETS).flatMap((target) => target.sections).filter((section) => section !== "scene"));
const LONG_TERM_FACT_SECTIONS = new Set(["worldFacts", "userProfile", "assistantProfile", "relationship"]);
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLEANUPS = Object.freeze({
  scene_expired: { section: "scene", targetKey: "scene", keys: ["cleanupKind", "expiredAt"] },
  expired_scene_evicted: { section: "scene", targetKey: "scene", keys: ["cleanupKind"] },
  todo_became_overdue: { section: "todos", targetKey: "todos", keys: ["cleanupKind", "itemId", "becameOverdueAt"] },
  todo_revived_from_overdue: { section: "todos", targetKey: "todos", keys: ["cleanupKind", "itemId", "dueAt"] },
  recent_episode_evicted: { section: "recentEpisodes", targetKey: "episodes", keys: ["cleanupKind", "itemId"] },
  suppressed_item_removed: { keys: ["cleanupKind", "itemId"] },
  suppressed_scene_field_cleared: { section: "scene", targetKey: "scene", keys: ["cleanupKind", "sceneSlot", "path"] },
});

function targetForSection(section) {
  return Object.entries(TARGETS).find(([, target]) => target.sections.includes(section))?.[0] ?? null;
}

function replayError(message) {
  const error = new Error(`Invalid Memory event replay: ${message}`);
  error.code = "MEMORY_V2_EVENT_REPLAY_INVALID";
  return error;
}
function fail(message) { throw replayError(message); }
function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function present(value) { return value !== null && value !== undefined; }
function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative safe integer`);
  return number;
}
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}
function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} has invalid fields`);
}
function requireIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
}
function requirePersistedRefs(refs, label) {
  if (!Array.isArray(refs) || refs.length === 0) fail(`${label} must be a non-empty array`);
  refs.forEach((ref, index) => {
    requireExactKeys(ref, ["messageId", "contentHash", "quote"], `${label}[${index}]`);
    safeInteger(ref.messageId, `${label}[${index}].messageId`);
    if (!CONTENT_HASH_PATTERN.test(ref.contentHash)) fail(`${label}[${index}].contentHash is invalid`);
    requireText(ref.quote, `${label}[${index}].quote`);
  });
}
function requireSourceRefs(refs, label) {
  const validation = validateSourceRefs(refs, label);
  if (!validation.ok) fail(`${label} is invalid`);
}
function requireNullish(value, label) {
  if (present(value)) fail(`${label} must be null`);
}

function validateOperationSection(operation, section, v201 = false) {
  const op = operation.op;
  if (["setField", "clearField"].includes(op)) {
    if (section !== "scene") fail(`${op} cannot target section ${section}`);
    if (!SCENE_FIELDS.includes(operation.path)) fail(`${op} has an invalid scene path`);
    return;
  }
  if (!ITEM_SECTIONS.has(section)) fail(`${op} cannot target section ${section}`);
  if (["completeTodo", "cancelTodo", "expireTodo"].includes(op) && section !== "todos") fail(`${op} requires todos`);
  if (op === "cancelAgreement" && section !== "standingAgreements") fail("cancelAgreement requires standingAgreements");
  if (op === "forgetItem" && !(v201 ? ITEM_SECTIONS : LONG_TERM_FACT_SECTIONS).has(section)) fail("forgetItem requires an allowed item section");
  if (op === "mergeItems" && section === "recentEpisodes") fail("mergeItems cannot target recentEpisodes");
}

function validateAcceptedOperationV201(event, operation) {
  const section = requireText(event.section, "event section");
  validateOperationSection(operation, section, true);
  if (rowValue(event, "op", "op") !== operation.op) fail("event op does not match normalized operation");
  requireNullish(rowValue(event, "evidence_kind", "evidenceKind"), "2.01 event evidence_kind");
  requireNullish(rowValue(event, "cleanup_type", "cleanupKind"), "accepted event cleanup_type");
  const eventItemId = rowValue(event, "item_id", "itemId");
  const resultItemId = rowValue(event, "result_item_id", "resultItemId");
  const mergedFrom = rowValue(event, "merged_from_item_ids", "mergedFromItemIds");
  if (operation.op === "setField") {
    requireExactKeys(operation, ["op", "path", "value", "sourceRefs"], "2.01 setField operation");
    requireText(operation.value, "setField value");
    requireSourceRefs(operation.sourceRefs, "setField sourceRefs");
  } else if (operation.op === "clearField") {
    requireExactKeys(operation, ["op", "path", "sourceRefs"], "2.01 clearField operation");
    requireSourceRefs(operation.sourceRefs, "clearField sourceRefs");
  } else if (operation.op === "addItem") {
    requireExactKeys(operation, ["op", "value", "sourceRefs"], "2.01 addItem operation");
    requireObject(operation.value, "addItem value");
    requireText(operation.value.id, "addItem value.id");
    requireSourceRefs(operation.sourceRefs, "addItem sourceRefs");
    if (!isDeepStrictEqual(operation.value.sourceRefs, operation.sourceRefs)) fail("addItem sourceRefs do not match value provenance");
    requireNullish(eventItemId, "addItem event item_id");
    if (resultItemId !== operation.value.id) fail("addItem result_item_id does not match value.id");
  } else if (operation.op === "mergeItems") {
    requireExactKeys(operation, ["op", "itemIds", "value"], "2.01 mergeItems operation");
    if (!Array.isArray(operation.itemIds) || operation.itemIds.length < 2 || new Set(operation.itemIds).size !== operation.itemIds.length) fail("mergeItems itemIds are invalid");
    requireObject(operation.value, "mergeItems value");
    requireText(operation.value.id, "mergeItems value.id");
    if (!isDeepStrictEqual(mergedFrom, operation.itemIds)) fail("mergeItems event sources do not match normalized operation");
    if (resultItemId !== operation.value.id) fail("mergeItems result_item_id does not match value.id");
  } else if (operation.op === "updateItem") {
    requireExactKeys(operation, ["op", "itemId", "value", "sourceRefs"], "2.01 updateItem operation");
    requireText(operation.itemId, "updateItem itemId");
    requireObject(operation.value, "updateItem value");
    requireSourceRefs(operation.sourceRefs, "updateItem sourceRefs");
    if (operation.value.id !== operation.itemId) fail("updateItem value.id does not match itemId");
    if (eventItemId !== operation.itemId) fail("updateItem event item_id does not match normalized operation");
  } else {
    requireExactKeys(operation, ["op", "itemId", "sourceRefs"], `2.01 ${operation.op} operation`);
    requireText(operation.itemId, `${operation.op} itemId`);
    requireSourceRefs(operation.sourceRefs, `${operation.op} sourceRefs`);
    if (eventItemId !== operation.itemId) fail(`${operation.op} event item_id does not match normalized operation`);
  }
  if (!["addItem", "mergeItems"].includes(operation.op)) requireNullish(resultItemId, `${operation.op} event result_item_id`);
  if (operation.op !== "mergeItems") requireNullish(mergedFrom, `${operation.op} event merged_from_item_ids`);
}

function validateAcceptedOperation(event, operation) {
  requireObject(operation, "normalized operation");
  if (!PATCH_OPS.includes(operation.op)) fail(`Unknown accepted operation: ${operation.op ?? "<missing>"}`);
  const section = requireText(event.section, "event section");
  validateOperationSection(operation, section);

  const eventOp = rowValue(event, "op", "op");
  if (eventOp !== operation.op) fail("event op does not match normalized operation");
  const eventItemId = rowValue(event, "item_id", "itemId");
  const resultItemId = rowValue(event, "result_item_id", "resultItemId");
  const mergedFrom = rowValue(event, "merged_from_item_ids", "mergedFromItemIds");
  const eventEvidenceKind = rowValue(event, "evidence_kind", "evidenceKind");
  if (!EVIDENCE_KINDS.includes(operation.evidenceKind)) fail("normalized operation evidenceKind is invalid");
  if (eventEvidenceKind !== operation.evidenceKind) fail("event evidence_kind does not match normalized operation");
  requireNullish(rowValue(event, "cleanup_type", "cleanupKind"), "accepted event cleanup_type");
  if (!["addItem", "mergeItems"].includes(operation.op)) requireNullish(resultItemId, `${operation.op} event result_item_id`);
  if (operation.op !== "mergeItems") requireNullish(mergedFrom, `${operation.op} event merged_from_item_ids`);

  if (operation.op === "setField") {
    requireExactKeys(operation, ["op", "path", "value", "evidenceKind", "evidenceRefs"], "setField operation");
    requireText(operation.value, "setField value");
    requirePersistedRefs(operation.evidenceRefs, "setField evidenceRefs");
    if (operation.evidenceRefs.length !== 1) fail("setField requires exactly one evidence ref");
  } else if (operation.op === "clearField") {
    requireExactKeys(operation, ["op", "path", "evidenceKind", "evidenceRefs"], "clearField operation");
    requirePersistedRefs(operation.evidenceRefs, "clearField evidenceRefs");
    if (operation.evidenceRefs.length !== 1) fail("clearField requires exactly one evidence ref");
  } else if (operation.op === "addItem") {
    requireExactKeys(operation, ["op", "value", "evidenceKind", "evidenceRefs"], "addItem operation");
    requireObject(operation.value, "addItem value");
    requireText(operation.value.id, "addItem value.id");
    requirePersistedRefs(operation.evidenceRefs, "addItem evidenceRefs");
    if (!Array.isArray(operation.value.evidenceGroups) || operation.value.evidenceGroups.length !== 1 || !isDeepStrictEqual(operation.value.evidenceGroups[0], { evidenceKind: operation.evidenceKind, refs: operation.evidenceRefs })) {
      fail("addItem evidenceRefs do not match value provenance");
    }
    requireNullish(eventItemId, "addItem event item_id");
    if (resultItemId !== operation.value.id) fail("addItem result_item_id does not match value.id");
  } else if (operation.op === "mergeItems") {
    requireExactKeys(operation, ["op", "itemIds", "value", "evidenceKind"], "mergeItems operation");
    if (!Array.isArray(operation.itemIds) || operation.itemIds.length < 2 || operation.itemIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(operation.itemIds).size !== operation.itemIds.length) {
      fail("mergeItems itemIds are invalid");
    }
    requireObject(operation.value, "mergeItems value");
    requireText(operation.value.id, "mergeItems value.id");
    requireNullish(eventItemId, "mergeItems event item_id");
    if (!isDeepStrictEqual(mergedFrom, operation.itemIds)) fail("mergeItems event sources do not match normalized operation");
    if (resultItemId !== operation.value.id) fail("mergeItems result_item_id does not match value.id");
  } else if (operation.op === "updateItem") {
    requireExactKeys(operation, ["op", "itemId", "value", "evidenceKind", "evidenceRefs"], "updateItem operation");
    requireText(operation.itemId, "updateItem itemId");
    requireObject(operation.value, "updateItem value");
    if (operation.value.id !== operation.itemId) fail("updateItem value.id does not match itemId");
    requirePersistedRefs(operation.evidenceRefs, "updateItem evidenceRefs");
    const newestGroup = operation.value.evidenceGroups?.at(-1);
    if (!isDeepStrictEqual(newestGroup, { evidenceKind: operation.evidenceKind, refs: operation.evidenceRefs })) fail("updateItem evidenceRefs do not match value provenance");
    if (eventItemId !== operation.itemId) fail("updateItem event item_id does not match normalized operation");
  } else {
    requireExactKeys(operation, ["op", "itemId", "evidenceKind", "evidenceRefs"], `${operation.op} operation`);
    requireText(operation.itemId, `${operation.op} itemId`);
    requirePersistedRefs(operation.evidenceRefs, `${operation.op} evidenceRefs`);
    if (eventItemId !== operation.itemId) fail(`${operation.op} event item_id does not match normalized operation`);
  }

}

function validateCleanupOperation(event, operation) {
  requireObject(operation, "cleanup normalized operation");
  const definition = CLEANUPS[operation.cleanupKind];
  if (!definition) fail(`Unknown cleanup kind: ${operation.cleanupKind ?? "<missing>"}`);
  requireExactKeys(operation, definition.keys, `${operation.cleanupKind} operation`);
  const expectedSection = operation.cleanupKind === "suppressed_item_removed" ? event.section : definition.section;
  const expectedTarget = operation.cleanupKind === "suppressed_item_removed" ? targetForSection(event.section) : definition.targetKey;
  if (operation.cleanupKind === "suppressed_item_removed" && !ITEM_SECTIONS.has(event.section)) fail("suppressed_item_removed requires an item section");
  if (!expectedTarget || event.section !== expectedSection || rowValue(event, "target_key", "targetKey") !== expectedTarget) fail(`${operation.cleanupKind} has inconsistent section or target`);
  if (rowValue(event, "cleanup_type", "cleanupKind") !== operation.cleanupKind) fail("event cleanup_type does not match normalized operation");
  requireNullish(rowValue(event, "op", "op"), "cleanup event op");
  requireNullish(rowValue(event, "result_item_id", "resultItemId"), "cleanup event result_item_id");
  requireNullish(rowValue(event, "merged_from_item_ids", "mergedFromItemIds"), "cleanup event merged_from_item_ids");
  requireNullish(rowValue(event, "evidence_kind", "evidenceKind"), "cleanup event evidence_kind");
  const eventItemId = rowValue(event, "item_id", "itemId");
  if (present(operation.itemId)) {
    requireText(operation.itemId, `${operation.cleanupKind} itemId`);
    if (eventItemId !== operation.itemId) fail(`${operation.cleanupKind} event item_id does not match normalized operation`);
  } else requireNullish(eventItemId, `${operation.cleanupKind} event item_id`);
  if (operation.expiredAt) requireIsoTimestamp(operation.expiredAt, "scene_expired expiredAt");
  if (operation.becameOverdueAt) requireIsoTimestamp(operation.becameOverdueAt, "todo_became_overdue becameOverdueAt");
  if (operation.dueAt) requireIsoTimestamp(operation.dueAt, "todo_revived_from_overdue dueAt");
  if (operation.cleanupKind === "suppressed_scene_field_cleared" && !SCENE_FIELDS.includes(operation.path)) fail("suppressed_scene_field_cleared path is invalid");
  if (operation.cleanupKind === "suppressed_scene_field_cleared" && !["scene", "previousScene"].includes(operation.sceneSlot)) fail("suppressed_scene_field_cleared sceneSlot is invalid");
}

function validateEventForGroup(event, group, expectedIndex, v201 = false) {
  const groupId = rowValue(group, "event_group_id", "eventGroupId");
  if (rowValue(event, "event_group_id", "eventGroupId") !== groupId) fail("event_group_id does not match group");
  if (safeInteger(rowValue(event, "event_index", "eventIndex"), "event_index") !== expectedIndex) fail(`event indexes for group ${groupId} are not contiguous`);
  for (const [snake, camel, label] of [["user_id", "userId", "user"], ["preset_id", "presetId", "preset"], ["task_id", "taskId", "task"]]) {
    if (String(rowValue(event, snake, camel)) !== String(rowValue(group, snake, camel))) fail(`event ${label} does not match group`);
  }
  const decision = event.decision;
  if (!DECISIONS.has(decision)) fail(`Replay group contains invalid decision: ${decision ?? "<missing>"}`);
  const operation = rowValue(event, "normalized_operation", "normalizedOperation");
  const eventKind = rowValue(event, "event_kind", "eventKind");
  if (decision === "accepted") {
    if (eventKind !== "proposal_decision") fail("accepted event must be a proposal_decision");
    if (!operation) fail("Replayable event is missing normalized operation");
    if (rowValue(event, "target_key", "targetKey") !== rowValue(group, "target_key", "targetKey")) fail("accepted event target does not match group");
    if (!TARGETS[rowValue(group, "target_key", "targetKey")]?.sections.includes(event.section)) fail("accepted event section does not belong to group target");
    if (v201) validateAcceptedOperationV201(event, operation);
    else validateAcceptedOperation(event, operation);
  } else if (decision === "system_cleanup") {
    if (eventKind !== "system_cleanup") fail("system_cleanup decision must use system_cleanup event kind");
    if (!operation) fail("Replayable event is missing normalized operation");
    validateCleanupOperation(event, operation);
  } else {
    if (eventKind !== "proposal_decision") fail(`${decision} event must be a proposal_decision`);
    if (operation) fail(`${decision} event must not carry a normalized operation`);
    if (rowValue(event, "target_key", "targetKey") !== rowValue(group, "target_key", "targetKey")) fail(`${decision} event target does not match group`);
    if (!TARGETS[rowValue(group, "target_key", "targetKey")]?.sections.includes(event.section)) fail(`${decision} event section does not belong to group target`);
  }
}

function applySemanticEvent(state, event, { v201 = state?.version === MEMORY_CONTROL_V201_SCHEMA_VERSION } = {}) {
  const operation = rowValue(event, "normalized_operation", "normalizedOperation");
  const decision = event.decision;
  if (!["accepted", "system_cleanup"].includes(decision)) return;
  if (!operation) fail("Replayable event is missing normalized operation");
  if (decision === "accepted") {
    if (!PATCH_OPS.includes(operation.op)) fail(`Unknown accepted operation: ${operation.op ?? "<missing>"}`);
    const section = event.section;
    if (operation.op === "setField") {
      if (v201) state.current.scene[operation.path] = {
        value: operation.value,
        sourceRefs: structuredClone(operation.sourceRefs),
        updatedAtMessageId: Math.max(...operation.sourceRefs.map((ref) => ref.messageId)),
      };
      else {
        const ref = operation.evidenceRefs[0];
        state.current.scene[operation.path] = { value: operation.value, evidenceRef: ref, updatedAtMessageId: ref.messageId };
      }
    } else if (operation.op === "clearField") {
      state.current.scene[operation.path] = v201
        ? { value: null, sourceRefs: [], updatedAtMessageId: null }
        : { value: null, evidenceRef: null, updatedAtMessageId: null };
    } else {
      const items = sectionItems(state, section);
      if (["completeTodo", "cancelTodo", "expireTodo", "cancelAgreement", "forgetItem"].includes(operation.op)) {
        const index = items.findIndex((item) => item.id === operation.itemId);
        if (index < 0) fail(`Replay item missing: ${operation.itemId}`);
        items.splice(index, 1);
      } else if (operation.op === "addItem") {
        items.push(structuredClone(operation.value));
      } else if (operation.op === "updateItem") {
        const index = items.findIndex((item) => item.id === operation.itemId);
        if (index < 0) fail(`Replay item missing: ${operation.itemId}`);
        items[index] = structuredClone(operation.value);
      } else if (operation.op === "mergeItems") {
        for (const id of operation.itemIds) {
          const index = items.findIndex((item) => item.id === id);
          if (index < 0) fail(`Replay merge source missing: ${id}`);
          items.splice(index, 1);
        }
        items.push(structuredClone(operation.value));
      }
    }
    return;
  }
  const definition = CLEANUPS[operation.cleanupKind];
  if (!definition) fail(`Unknown cleanup kind: ${operation.cleanupKind ?? "<missing>"}`);
  if (operation.cleanupKind === "scene_expired") {
    state.current.previousScene = { ...structuredClone(state.current.scene), expiredAt: operation.expiredAt };
    state.current.scene = v201 ? createEmptySceneV201() : createEmptyScene();
  } else if (operation.cleanupKind === "expired_scene_evicted") {
    // scene_expired in the same group already replaced the previous value.
  } else if (operation.cleanupKind === "todo_became_overdue") {
    const item = state.working.todos.find((candidate) => candidate.id === operation.itemId);
    if (!item) fail(`Replay todo missing: ${operation.itemId}`);
    item.status = "overdue";
    item.becameOverdueAt = operation.becameOverdueAt;
  } else if (operation.cleanupKind === "todo_revived_from_overdue") {
    const item = state.working.todos.find((candidate) => candidate.id === operation.itemId);
    if (!item) fail(`Replay todo missing: ${operation.itemId}`);
    item.status = "active";
    item.becameOverdueAt = null;
    item.dueAt = operation.dueAt;
  } else if (operation.cleanupKind === "recent_episode_evicted") {
    const index = state.working.recentEpisodes.findIndex((item) => item.id === operation.itemId);
    if (index < 0) fail(`Replay episode missing: ${operation.itemId}`);
    state.working.recentEpisodes.splice(index, 1);
  } else if (operation.cleanupKind === "suppressed_item_removed") {
    const items = sectionItems(state, event.section);
    const index = items.findIndex((item) => item.id === operation.itemId);
    if (index < 0) fail(`Replay suppressed item missing: ${operation.itemId}`);
    items.splice(index, 1);
  } else if (operation.cleanupKind === "suppressed_scene_field_cleared") {
    if (!state.current[operation.sceneSlot]) fail(`Replay scene slot missing: ${operation.sceneSlot}`);
    state.current[operation.sceneSlot][operation.path] = { value: null, evidenceRef: null, updatedAtMessageId: null };
  }
}

function replayEventGroups(anchorState, groups, events, expectedScope = {}) {
  const v201 = anchorState?.version === MEMORY_CONTROL_V201_SCHEMA_VERSION;
  if (v201) assertMemoryStateV201(anchorState);
  else assertMemoryState(anchorState);
  if (!Array.isArray(groups) || !Array.isArray(events)) fail("groups and events must be arrays");
  const state = structuredClone(anchorState);
  const byGroup = new Map();
  const knownGroups = new Map();
  for (const group of groups) {
    const groupId = requireText(rowValue(group, "event_group_id", "eventGroupId"), "event_group_id");
    if (knownGroups.has(groupId)) fail(`Duplicate event group: ${groupId}`);
    knownGroups.set(groupId, group);
  }
  for (const event of events) {
    const groupId = requireText(rowValue(event, "event_group_id", "eventGroupId"), "event event_group_id");
    if (!knownGroups.has(groupId)) fail(`Event belongs to unknown group: ${groupId}`);
    const rows = byGroup.get(groupId) || [];
    rows.push(event);
    byGroup.set(groupId, rows);
  }

  const scopeUserId = expectedScope.userId ?? rowValue(groups[0], "user_id", "userId");
  const scopePresetId = expectedScope.presetId ?? rowValue(groups[0], "preset_id", "presetId");
  for (const group of groups) {
    const groupId = rowValue(group, "event_group_id", "eventGroupId");
    if (!present(rowValue(group, "result_revision", "resultRevision"))) fail("Audit-only group cannot be replayed");
    const groupSchemaVersion = rowValue(group, "schema_version", "schemaVersion");
    if (v201) {
      if (String(groupSchemaVersion) !== MEMORY_CONTROL_V201_SCHEMA_VERSION) fail("Replay schema version mismatch");
    } else if (safeInteger(groupSchemaVersion, "group schema_version") !== SCHEMA_VERSION || anchorState.version !== SCHEMA_VERSION) fail("Replay schema version mismatch");
    if (safeInteger(rowValue(group, "source_generation", "sourceGeneration"), "group source_generation") !== state.meta.sourceGeneration) fail("Replay source generation mismatch");
    if (String(rowValue(group, "user_id", "userId")) !== String(scopeUserId) || String(rowValue(group, "preset_id", "presetId")) !== String(scopePresetId)) fail("Replay group scope mismatch");
    requireText(rowValue(group, "task_id", "taskId"), "group task_id");
    const targetKey = requireText(rowValue(group, "target_key", "targetKey"), "group target_key");
    if (!TARGETS[targetKey]) fail(`Unknown group target: ${targetKey}`);
    const groupKind = rowValue(group, "group_kind", "groupKind");
    if (!GROUP_KINDS.has(groupKind)) fail(`Unknown group kind: ${groupKind ?? "<missing>"}`);
    const baseRevision = safeInteger(rowValue(group, "base_revision", "baseRevision"), "group base_revision");
    const resultRevision = safeInteger(rowValue(group, "result_revision", "resultRevision"), "group result_revision");
    if (baseRevision !== state.meta.revision) fail(`Replay revision gap before group ${groupId}`);
    if (resultRevision !== baseRevision + 1) fail(`Group ${groupId} result revision must equal base revision + 1`);

    const cursorBeforeRaw = rowValue(group, "cursor_before", "cursorBefore");
    const cursorAfterRaw = rowValue(group, "cursor_after", "cursorAfter");
    if (groupKind === "proposal") {
      const cursorBefore = safeInteger(cursorBeforeRaw, "proposal cursor_before");
      const cursorAfter = safeInteger(cursorAfterRaw, "proposal cursor_after");
      const currentCursor = state.meta.targetCursors[targetKey] ?? 0;
      if (cursorBefore !== currentCursor) fail(`Cursor discontinuity before group ${groupId}`);
      if (cursorAfter <= cursorBefore) fail(`Cursor did not advance in group ${groupId}`);
    } else if (present(cursorBeforeRaw) || present(cursorAfterRaw)) fail(`${groupKind} group must not carry cursors`);

    const rows = (byGroup.get(groupId) || []).sort((left, right) => Number(rowValue(left, "event_index", "eventIndex")) - Number(rowValue(right, "event_index", "eventIndex")));
    if (!rows.length && groupKind !== "proposal") fail(`${groupKind} group must contain semantic events`);
    rows.forEach((event, index) => validateEventForGroup(event, group, index, v201));
    if (groupKind === "system_cleanup" && rows.some((event) => event.decision !== "system_cleanup")) fail("system_cleanup group contains a proposal decision");
    if (groupKind === "system_cleanup" && rows.some((event) => rowValue(event, "target_key", "targetKey") !== targetKey)) fail("system_cleanup event target does not match group");
    if (groupKind === "maintenance" && rows.some((event) => event.decision === "noop")) fail("maintenance group contains noop");
    if (groupKind === "maintenance" && !rows.some((event) => ["accepted", "system_cleanup"].includes(event.decision))) fail("maintenance revision has no semantic operation");
    if (groupKind === "proposal" && rows.length && !rows.some((event) => ["accepted", "rejected", "noop"].includes(event.decision))) fail("proposal revision contains only cleanup events");
    const cleanupKinds = rows.filter((event) => event.decision === "system_cleanup").map((event) => rowValue(event, "cleanup_type", "cleanupKind"));
    if (cleanupKinds.includes("expired_scene_evicted") && !cleanupKinds.includes("scene_expired")) fail("expired_scene_evicted requires scene_expired in the same group");
    if (cleanupKinds.indexOf("expired_scene_evicted") >= 0 && cleanupKinds.indexOf("expired_scene_evicted") < cleanupKinds.indexOf("scene_expired")) fail("expired_scene_evicted must follow scene_expired");

    rows.forEach((event) => applySemanticEvent(state, event, { v201 }));
    state.meta.revision = resultRevision;
    if (groupKind === "proposal") state.meta.targetCursors[targetKey] = safeInteger(cursorAfterRaw, "proposal cursor_after");
    if (v201) assertMemoryStateV201(state);
    else assertMemoryState(state);
  }
  return state;
}

module.exports = { applySemanticEvent, replayEventGroups };
