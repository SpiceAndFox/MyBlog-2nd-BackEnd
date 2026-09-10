const crypto = require("node:crypto");
const {
  TARGETS,
  normalizeSourceRefs,
  validateCompiledProposal,
  assertMemoryState,
} = require("../contracts");
const { normalizeItemText } = require("./itemDeduplication");
const { allocateMemoryItemId } = require("./itemIds");
const { normalizeLifecycle } = require("./lifecycle");
const { findCapacityViolation, measureSection } = require("./capacity");
const { sectionLimits, codePointLength, EPISODE_APPEND_SEPARATOR } = require("../contracts/sectionPolicy");
const { rejectWrite, assertItemLimits, locateWriteError } = require("./writeGuards");
const { applyTodoRevision } = require("./todoRevision");

const SECTION_TARGETS = Object.freeze(Object.fromEntries(
  Object.entries(TARGETS).flatMap(([target, value]) => value.sections.map((section) => [section, target])),
));
function sectionItems(state, section) {
  return ["todos", "standingAgreements", "recentEpisodes"].includes(section) ? state.working[section] : state.longTerm[section];
}

function eventBase(section, patch, decision, patchId) {
  return {
    eventKind: "proposal_decision",
    section,
    targetKey: SECTION_TARGETS[section],
    decision,
    patchId,
    op: patch.op,
    itemId: patch.itemId || null,
    mergedFromItemIds: patch.itemIds?.slice() || null,
    resultItemId: null,
    rejectReason: null,
    patchSummary: structuredClone(patch),
    normalizedOperation: null,
  };
}

function conflictKeys(section, patch) {
  if (["setField", "correctField", "clearField"].includes(patch.op)) return [`${section}:field:${patch.path}`];
  if (patch.itemId) return [`${section}:item:${patch.itemId}`];
  return (patch.itemIds || []).map((id) => `${section}:item:${id}`);
}

function exactDuplicate(items, text, excludeItemId = null) {
  const normalized = normalizeItemText(text);
  return normalized && items.some((item) => item.id !== excludeItemId && normalizeItemText(item.text) === normalized);
}

function applyPatch(state, section, patch, { idFactory, nowMs, cleanupEvents, task }) {
  const boundary = task.targetMessageId;
  if (["setField", "correctField"].includes(patch.op)) {
    const sourceRefs = structuredClone(patch.sourceRefs);
    state.current.scene[patch.path] = {
      value: patch.value,
      sourceRefs,
      updatedAtMessageId: boundary,
    };
    assertItemLimits(section, patch.value, sourceRefs, task);
    return { normalizedOperation: { ...structuredClone(patch), updatedAtMessageId: boundary } };
  }
  if (patch.op === "clearField") {
    state.current.scene[patch.path] = { value: null, sourceRefs: [], updatedAtMessageId: null };
    return { normalizedOperation: structuredClone(patch) };
  }

  const items = sectionItems(state, section);
  if (patch.op === "addItem") {
    const sourceRefs = structuredClone(patch.sourceRefs);
    const item = {
      id: allocateMemoryItemId(state, section, idFactory),
      text: patch.value.text,
      sourceRefs,
      createdAtMessageId: boundary,
      updatedAtMessageId: boundary,
    };
    if (section === "todos") Object.assign(item, {
      actor: patch.value.actor,
      requester: patch.value.requester,
      status: "active",
      becameOverdueAt: null,
      dueAt: patch.value.dueAt,
    });
    assertItemLimits(section, item.text, sourceRefs, task);
    items.push(item);
    return { resultItemId: item.id, normalizedOperation: { op: patch.op, value: structuredClone(item), sourceRefs } };
  }

  if (patch.op === "mergeItems") {
    const sources = patch.itemIds.map((id) => items.find((item) => item.id === id));
    if (sources.some((item) => !item)) return { rejectReason: "item_not_found" };
    if (section === "todos" && sources.some((item) => item.status !== "active" || item.actor !== sources[0].actor || item.requester !== sources[0].requester || item.dueAt !== sources[0].dueAt)) return { rejectReason: "invalid_state_transition" };
    const sourceRefs = structuredClone(patch.sourceRefs);
    const authorized = sources.flatMap((item) => item.sourceRefs);
    if (sourceRefs.some((ref) => !authorized.some((entry) => entry.messageId === ref.messageId && entry.contentHash === ref.contentHash))) rejectWrite("merge_evidence_not_authorized", section);
    assertItemLimits(section, patch.value.text, sourceRefs, task);
    const item = {
      id: allocateMemoryItemId(state, section, idFactory),
      text: patch.value.text,
      sourceRefs,
      createdAtMessageId: boundary,
      updatedAtMessageId: boundary,
    };
    if (section === "todos") Object.assign(item, {
      actor: sources[0].actor, requester: sources[0].requester, status: "active", becameOverdueAt: null, dueAt: sources[0].dueAt,
    });
    for (const source of sources) items.splice(items.findIndex((candidate) => candidate.id === source.id), 1);
    items.push(item);
    return { resultItemId: item.id, normalizedOperation: { op: patch.op, itemIds: patch.itemIds.slice(), value: structuredClone(item) } };
  }

  const index = items.findIndex((item) => item.id === patch.itemId);
  if (index < 0) return { rejectReason: "item_not_found" };
  const item = items[index];
  if (["forgetItem", "completeTodo", "cancelTodo", "expireTodo", "cancelAgreement"].includes(patch.op)) {
    items.splice(index, 1);
    return { normalizedOperation: structuredClone(patch) };
  }
  if (!["appendItem", "reviseItem", "correctItem"].includes(patch.op)) return { rejectReason: "schema_invalid" };
  if (section === "todos") {
    const todo = applyTodoRevision(item, patch, nowMs, task);
    if (todo.noop) return { noopReason: "unchanged_todo" };
    if (todo.revived) cleanupEvents.push({
      eventKind: "system_cleanup", section: "todos", targetKey: "todos", decision: "system_cleanup",
      cleanupKind: "todo_revived_from_overdue",
      normalizedOperation: { cleanupKind: "todo_revived_from_overdue", itemId: item.id, dueAt: item.dueAt },
    });
    return { normalizedOperation: { op: patch.op, itemId: item.id, value: structuredClone(item), sourceRefs: structuredClone(patch.sourceRefs) } };
  }
  if (patch.op === "appendItem") {
    const limits = sectionLimits(section, task);
    if (section !== "recentEpisodes" || !limits.maxAppendChars) rejectWrite("action_not_allowed", section);
    const existingChars = codePointLength(item.text);
    const separatorChars = codePointLength(EPISODE_APPEND_SEPARATOR);
    const limit = Math.max(0, Math.min(limits.maxAppendChars, limits.maxItemChars - existingChars - separatorChars));
    if (codePointLength(patch.value.text) > limit) rejectWrite("append_length_exceeded", section, {
      action: "append", limit, actual: codePointLength(patch.value.text), existingChars, separatorChars, maxItemChars: limits.maxItemChars,
    });
    item.text = `${item.text}${EPISODE_APPEND_SEPARATOR}${patch.value.text}`;
  } else if (patch.value.text !== undefined) item.text = patch.value.text;
  const sourceRefs = patch.op === "appendItem"
    ? normalizeSourceRefs([...item.sourceRefs, ...patch.sourceRefs])
    : structuredClone(patch.sourceRefs);
  assertItemLimits(section, item.text, sourceRefs, task);
  item.sourceRefs = sourceRefs;
  item.updatedAtMessageId = boundary;
  return { normalizedOperation: { op: patch.op, itemId: item.id, value: structuredClone(item), sourceRefs: structuredClone(patch.sourceRefs) } };
}

function reduceCompiledProposal({
  state,
  task,
  proposal,
  now = task.now,
  config,
  lifecycleAnchors = {},
  idFactory = () => crypto.randomUUID(),
  protectedItemIds = [],
} = {}) {
  assertMemoryState(state);
  const proposalValidation = validateCompiledProposal(proposal, task);
  if (!proposalValidation.ok) {
    const error = new Error(`Invalid compiled Memory proposal: ${proposalValidation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_COMPILED_PROPOSAL_INVALID";
    error.validationErrors = proposalValidation.errors;
    throw error;
  }
  const original = structuredClone(state);
  const working = structuredClone(state);
  const events = [];
  const cleanupEvents = [];
  const seen = new Set();
  const protectedIds = new Set(protectedItemIds);
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be an ISO timestamp");
  const reject = (base, reason) => {
    // A maintenance attempt may encounter items protected by a pending parent.
    // Normal output is all-or-nothing, including exact duplicates and conflicts.
    if (task.mode !== "maintenance") rejectWrite(reason, base.section);
    events.push({ ...base, decision: "rejected", rejectReason: reason });
  };

  for (const section of task.targetSections) {
    const result = proposal.sectionResults[section];
    if (result.status === "noop") {
      events.push({ ...eventBase(section, {}, "noop", null), op: null, patchSummary: null });
      continue;
    }
    for (const [changeIndex, patch] of result.patches.entries()) {
      try {
        const patchId = idFactory();
        const base = eventBase(section, patch, "accepted", patchId);
        if (patch.op === "mergeItems" && patch.itemIds.some((itemId) => protectedIds.has(itemId))) {
          events.push({ ...base, decision: "rejected", rejectReason: "item_protected_by_pending_proposal" });
          continue;
        }
        const keys = conflictKeys(section, patch);
        if (keys.some((key) => seen.has(key))) {
          reject(base, "invalid_state_transition");
          continue;
        }
        if (["addItem", "reviseItem", "correctItem"].includes(patch.op) && patch.value.text !== undefined
          && exactDuplicate(sectionItems(working, section), patch.value.text, patch.itemId || null)) {
          reject(base, "duplicate_item");
          continue;
        }
        const previousScene = section === "scene" ? structuredClone(working.current.scene[patch.path]) : null;
        const applied = applyPatch(working, section, patch, { idFactory, nowMs, cleanupEvents, task });
        if (applied.rejectReason) {
          reject(base, applied.rejectReason);
          continue;
        }
        if (section === "scene" && measureSection(working, "scene").renderedChars > config.scene.maxRenderedChars) {
          working.current.scene[patch.path] = previousScene;
          reject(base, "capacity_exceeded");
          continue;
        }
        keys.forEach((key) => seen.add(key));
        if (applied.noopReason) {
          events.push({ ...base, decision: "noop", patchSummary: { ...base.patchSummary, noopReason: applied.noopReason } });
          continue;
        }
        events.push({ ...base, resultItemId: applied.resultItemId || null, normalizedOperation: applied.normalizedOperation });
      } catch (error) {
        throw locateWriteError(error, section, changeIndex);
      }
    }
  }

  const lifecycle = normalizeLifecycle(working, lifecycleAnchors, now, config);
  const acceptedSections = [...new Set(events.filter((event) => event.decision === "accepted").map((event) => event.section))];
  const violation = findCapacityViolation(lifecycle.state, config, acceptedSections);
  if (violation) {
    const trigger = events.findLast((event) => event.decision === "accepted" && event.section === violation.section);
    return {
      outcome: "deferred",
      state: original,
      events: [{ ...trigger, decision: "deferred", resultItemId: null, normalizedOperation: null }],
      cleanupEvents: [],
      capacityViolation: violation,
      snapshot: null,
    };
  }
  const finalState = lifecycle.state;
  finalState.meta.revision = state.meta.revision + 1;
  if (task.mode !== "maintenance") finalState.meta.targetCursors[task.targetKey] = task.targetMessageId;
  assertMemoryState(finalState);
  const allCleanupEvents = [...cleanupEvents, ...lifecycle.events];
  return {
    outcome: "committable",
    state: finalState,
    events: [...events, ...allCleanupEvents],
    cleanupEvents: allCleanupEvents,
    capacityViolation: null,
    snapshot: structuredClone(finalState),
  };
}

module.exports = { reduceCompiledProposal };
