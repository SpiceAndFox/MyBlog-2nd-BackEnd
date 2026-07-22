const crypto = require("node:crypto");
const {
  TARGETS,
  normalizeSourceRefs,
  validateCompiledProposal,
  assertMemoryState,
} = require("../contracts");
const { normalizeItemText } = require("./itemDeduplication");
const { normalizeLifecycle } = require("./lifecycle");
const { findCapacityViolation, measureSection } = require("./capacity");

const SECTION_TARGETS = Object.freeze(Object.fromEntries(
  Object.entries(TARGETS).flatMap(([target, value]) => value.sections.map((section) => [section, target])),
));
const SECTION_PREFIX = Object.freeze({
  todos: "todo", standingAgreements: "agreement", recentEpisodes: "episode", milestones: "milestone",
  worldFacts: "worldFact", userProfile: "userProfile", assistantProfile: "assistantProfile", relationship: "relationship",
});

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
  if (["setField", "clearField"].includes(patch.op)) return [`${section}:field:${patch.path}`];
  if (patch.itemId) return [`${section}:item:${patch.itemId}`];
  return (patch.itemIds || []).map((id) => `${section}:item:${id}`);
}

function exactDuplicate(items, text, excludeItemId = null) {
  const normalized = normalizeItemText(text);
  return normalized && items.some((item) => item.id !== excludeItemId && normalizeItemText(item.text) === normalized);
}

function allStateItemIds(state) {
  return [
    ...state.working.todos,
    ...state.working.standingAgreements,
    ...state.working.recentEpisodes,
    ...state.longTerm.milestones,
    ...state.longTerm.worldFacts,
    ...state.longTerm.userProfile,
    ...state.longTerm.assistantProfile,
    ...state.longTerm.relationship,
  ].map((item) => item.id);
}

function nextItemId(state, section, idFactory) {
  const existing = new Set(allStateItemIds(state));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `${SECTION_PREFIX[section]}:${idFactory()}`;
    if (!existing.has(id)) return id;
  }
  throw new Error("Unable to allocate a unique Memory item id");
}

function updateTodo(item, value, nowMs) {
  if (item.status === "overdue") {
    if (value.dueChange.mode !== "set" || new Date(value.dueChange.dueAt).getTime() <= nowMs) return { ok: false };
    if ((value.actor !== undefined && value.actor !== item.actor) || (value.requester !== undefined && value.requester !== item.requester)) return { ok: false };
    item.status = "active";
    item.becameOverdueAt = null;
  }
  if (value.actor !== undefined) item.actor = value.actor;
  if (value.requester !== undefined) item.requester = value.requester;
  if (value.dueChange.mode === "clear") item.dueAt = null;
  if (value.dueChange.mode === "set") item.dueAt = value.dueChange.dueAt;
  return { ok: true };
}

function applyPatch(state, section, patch, { idFactory, nowMs, cleanupEvents }) {
  if (patch.op === "setField") {
    const sourceRefs = structuredClone(patch.sourceRefs);
    state.current.scene[patch.path] = {
      value: patch.value,
      sourceRefs,
      updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)),
    };
    return { normalizedOperation: structuredClone(patch) };
  }
  if (patch.op === "clearField") {
    state.current.scene[patch.path] = { value: null, sourceRefs: [], updatedAtMessageId: null };
    return { normalizedOperation: structuredClone(patch) };
  }

  const items = sectionItems(state, section);
  if (patch.op === "addItem") {
    const sourceRefs = structuredClone(patch.sourceRefs);
    const item = {
      id: nextItemId(state, section, idFactory),
      text: patch.value.text,
      sourceRefs,
      createdAtMessageId: Math.min(...sourceRefs.map((ref) => ref.messageId)),
      updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)),
    };
    if (section === "todos") Object.assign(item, {
      actor: patch.value.actor,
      requester: patch.value.requester,
      status: "active",
      becameOverdueAt: null,
      dueAt: patch.value.dueAt,
    });
    items.push(item);
    return { resultItemId: item.id, normalizedOperation: { op: patch.op, value: structuredClone(item), sourceRefs } };
  }

  if (patch.op === "mergeItems") {
    const sources = patch.itemIds.map((id) => items.find((item) => item.id === id));
    if (sources.some((item) => !item)) return { rejectReason: "item_not_found" };
    if (section === "todos" && sources.some((item) => item.status !== "active" || item.actor !== sources[0].actor || item.requester !== sources[0].requester || item.dueAt !== sources[0].dueAt)) return { rejectReason: "invalid_state_transition" };
    const sourceRefs = normalizeSourceRefs(sources.flatMap((item) => item.sourceRefs));
    const item = {
      id: nextItemId(state, section, idFactory),
      text: patch.value.text,
      sourceRefs,
      createdAtMessageId: Math.min(...sources.map((source) => source.createdAtMessageId)),
      updatedAtMessageId: Math.max(...sourceRefs.map((ref) => ref.messageId)),
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
  if (patch.op !== "updateItem") return { rejectReason: "schema_invalid" };
  if (section === "todos") {
    const wasOverdue = item.status === "overdue";
    const todo = updateTodo(item, patch.value, nowMs);
    if (!todo.ok) return { rejectReason: "invalid_state_transition" };
    if (wasOverdue) cleanupEvents.push({
      eventKind: "system_cleanup", section: "todos", targetKey: "todos", decision: "system_cleanup",
      cleanupKind: "todo_revived_from_overdue",
      normalizedOperation: { cleanupKind: "todo_revived_from_overdue", itemId: item.id, dueAt: item.dueAt },
    });
  }
  if (patch.value.text !== undefined) item.text = patch.value.text;
  const sourceRefs = normalizeSourceRefs([...item.sourceRefs, ...patch.sourceRefs]);
  item.sourceRefs = sourceRefs;
  item.updatedAtMessageId = Math.max(...sourceRefs.map((ref) => ref.messageId));
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

  for (const section of task.targetSections) {
    const result = proposal.sectionResults[section];
    if (result.status === "noop") {
      events.push({ ...eventBase(section, {}, "noop", null), op: null, patchSummary: null });
      continue;
    }
    for (const patch of result.patches) {
      const patchId = idFactory();
      const base = eventBase(section, patch, "accepted", patchId);
      if (patch.op === "mergeItems" && patch.itemIds.some((itemId) => protectedIds.has(itemId))) {
        events.push({ ...base, decision: "rejected", rejectReason: "item_protected_by_pending_proposal" });
        continue;
      }
      const keys = conflictKeys(section, patch);
      if (keys.some((key) => seen.has(key))) {
        events.push({ ...base, decision: "rejected", rejectReason: "invalid_state_transition" });
        continue;
      }
      if (["addItem", "updateItem"].includes(patch.op) && patch.value.text !== undefined
        && exactDuplicate(sectionItems(working, section), patch.value.text, patch.itemId || null)) {
        events.push({ ...base, decision: "rejected", rejectReason: "duplicate_item" });
        continue;
      }
      const previousScene = section === "scene" ? structuredClone(working.current.scene[patch.path]) : null;
      const applied = applyPatch(working, section, patch, { idFactory, nowMs, cleanupEvents });
      if (applied.rejectReason) {
        events.push({ ...base, decision: "rejected", rejectReason: applied.rejectReason });
        continue;
      }
      if (section === "scene" && measureSection(working, "scene").renderedChars > config.scene.maxRenderedChars) {
        working.current.scene[patch.path] = previousScene;
        events.push({ ...base, decision: "rejected", rejectReason: "capacity_exceeded" });
        continue;
      }
      keys.forEach((key) => seen.add(key));
      events.push({ ...base, resultItemId: applied.resultItemId || null, normalizedOperation: applied.normalizedOperation });
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
