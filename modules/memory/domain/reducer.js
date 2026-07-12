const crypto = require("node:crypto");
const { TARGETS } = require("../contracts/constants");
const { assertMemoryState } = require("../contracts/state");
const { validatePatch } = require("../contracts/proposal");
const { validateEvidenceRefs } = require("./evidence");
const { isPolicyAllowed } = require("./policy");
const { resolveDueAt } = require("./calendar");
const { normalizeLifecycle } = require("./lifecycle");
const { findCapacityViolation } = require("./capacity");

const SECTION_TARGETS = Object.freeze(Object.fromEntries(
  Object.entries(TARGETS).flatMap(([target, value]) => value.sections.map((section) => [section, target]))
));
const SECTION_PREFIX = Object.freeze({
  todos: "todo", standingAgreements: "agreement", recentEpisodes: "episode", milestones: "milestone",
  worldFacts: "worldFact", userProfile: "userProfile", assistantProfile: "assistantProfile", relationship: "relationship",
});

function sectionItems(state, section) {
  return ["todos", "standingAgreements", "recentEpisodes"].includes(section) ? state.working[section] : state.longTerm[section];
}
function newestMessageId(refs) { return Math.max(...refs.map((ref) => ref.messageId)); }
function eventBase(section, patch, decision, patchId) {
  return {
    eventKind: "proposal_decision", section, targetKey: SECTION_TARGETS[section], decision,
    patchId, op: patch.op, evidenceKind: patch.evidenceKind,
    itemId: patch.itemId || null, mergedFromItemIds: patch.op === "mergeItems" ? patch.itemIds.slice() : null,
    resultItemId: null, rejectReason: null, patchSummary: structuredClone(patch), normalizedOperation: null,
  };
}
function rejected(section, patch, patchId, reason) {
  return { ...eventBase(section, patch, "rejected", patchId), rejectReason: reason };
}
function evidenceGroup(patch, refs) { return { evidenceKind: patch.evidenceKind, refs }; }
function allEvidenceMessageIds(items) {
  return items.flatMap((item) => item.evidenceGroups.flatMap((group) => group.refs.map((ref) => ref.messageId)));
}

function deriveLifecycleAnchors(state, anchors, messagesById) {
  const messageIds = Object.values(state.current.scene)
    .map((field) => field.updatedAtMessageId)
    .filter((messageId) => messageId !== null);
  if (!messageIds.length) return anchors;
  const newest = Math.max(...messageIds);
  const createdAt = messagesById.get(newest)?.createdAt;
  return createdAt ? { ...anchors, sceneAnchorCreatedAt: createdAt } : anchors;
}

function resolvePatchDueAt(patch, refs, messagesById, timeZone) {
  const expression = patch.op === "addItem" ? patch.value.dueAt : patch.value.dueChange?.dueAt;
  if (!expression) return null;
  const anchorId = newestMessageId(refs);
  return resolveDueAt(expression, messagesById.get(anchorId).createdAt, timeZone);
}

function applyPatch(state, section, patch, refs, context, identityKey) {
  const normalized = structuredClone(patch);
  if (patch.op === "setField") {
    const ref = refs[0];
    state.current.scene[patch.path] = { value: patch.value, evidenceRef: ref, updatedAtMessageId: ref.messageId };
    normalized.evidenceRefs = refs;
    return { normalized };
  }
  if (patch.op === "clearField") {
    state.current.scene[patch.path] = { value: null, evidenceRef: null, updatedAtMessageId: null };
    normalized.evidenceRefs = refs;
    return { normalized };
  }

  const items = sectionItems(state, section);
  if (patch.op === "addItem") {
    const itemId = context.itemIds[identityKey] || `${SECTION_PREFIX[section]}:${context.idFactory()}`;
    context.itemIds[identityKey] = itemId;
    const first = Math.min(...refs.map((ref) => ref.messageId));
    const last = newestMessageId(refs);
    const item = { id: itemId, text: patch.value.text, evidenceGroups: [evidenceGroup(patch, refs)], createdAtMessageId: first, updatedAtMessageId: last };
    if (section === "todos") Object.assign(item, {
      actor: patch.value.actor, requester: patch.value.requester, status: "active", becameOverdueAt: null,
      dueAt: patch.value.dueAt ? resolvePatchDueAt(patch, refs, context.messagesById, context.timeZone) : null,
    });
    items.push(item);
    normalized.value = structuredClone(item);
    return { normalized, resultItemId: itemId };
  }

  if (patch.op === "mergeItems") {
    const sources = patch.itemIds.map((id) => items.find((item) => item.id === id));
    if (sources.some((item) => !item)) return { rejectReason: "item_not_found" };
    if (section === "todos" && sources.some((item) => item.status !== "active" || item.actor !== sources[0].actor || item.requester !== sources[0].requester || item.dueAt !== sources[0].dueAt)) {
      return { rejectReason: "invalid_state_transition" };
    }
    const itemId = context.itemIds[identityKey] || `${SECTION_PREFIX[section]}:${context.idFactory()}`;
    context.itemIds[identityKey] = itemId;
    const messageIds = allEvidenceMessageIds(sources);
    const item = {
      id: itemId, text: patch.value.text,
      evidenceGroups: sources.flatMap((item) => structuredClone(item.evidenceGroups)),
      createdAtMessageId: Math.min(...sources.map((item) => item.createdAtMessageId)),
      updatedAtMessageId: Math.max(...messageIds),
    };
    if (section === "todos") Object.assign(item, {
      actor: sources[0].actor, requester: sources[0].requester, status: "active", becameOverdueAt: null, dueAt: sources[0].dueAt,
    });
    for (const id of patch.itemIds) items.splice(items.findIndex((candidate) => candidate.id === id), 1);
    items.push(item);
    normalized.value = structuredClone(item);
    return { normalized, resultItemId: itemId };
  }

  const index = items.findIndex((item) => item.id === patch.itemId);
  if (index < 0) return { rejectReason: "item_not_found" };
  const item = items[index];
  if (["completeTodo", "cancelTodo", "expireTodo", "cancelAgreement", "forgetItem"].includes(patch.op)) {
    if (patch.op === "expireTodo" && item.status === "overdue") return { rejectReason: "invalid_state_transition" };
    items.splice(index, 1);
    normalized.evidenceRefs = refs;
    const tombstones = patch.op === "forgetItem" ? item.evidenceGroups.flatMap((group) => group.refs.map((ref) => ({
      messageId: ref.messageId, contentHash: ref.contentHash, reason: "forget", sourceItemId: item.id, sourceSection: section,
    }))) : [];
    return { normalized, tombstones };
  }

  if (patch.op === "updateItem") {
    const replacedEvidence = ["user_correction", "assistant_correction"].includes(patch.evidenceKind)
      ? item.evidenceGroups.flatMap((group) => group.refs.map((ref) => ({
        messageId: ref.messageId, contentHash: ref.contentHash, reason: "correction", sourceItemId: item.id, sourceSection: section,
      })))
      : [];
    if (section === "todos" && item.status === "overdue") {
      if (patch.value.dueChange.mode !== "set") return { rejectReason: "invalid_state_transition" };
      if ((patch.value.actor !== undefined && patch.value.actor !== item.actor) || (patch.value.requester !== undefined && patch.value.requester !== item.requester)) {
        return { rejectReason: "invalid_state_transition" };
      }
      const dueAt = resolvePatchDueAt(patch, refs, context.messagesById, context.timeZone);
      if (new Date(dueAt).getTime() <= context.nowMs) return { rejectReason: "invalid_state_transition" };
      item.dueAt = dueAt;
      item.status = "active";
      item.becameOverdueAt = null;
      context.cleanupEvents.push({
        eventKind: "system_cleanup", section: "todos", targetKey: "todos", cleanupKind: "todo_revived_from_overdue",
        normalizedOperation: { cleanupKind: "todo_revived_from_overdue", itemId: item.id, dueAt },
      });
    }
    if (patch.value.text !== undefined) item.text = patch.value.text;
    if (section === "todos") {
      if (patch.value.actor !== undefined) item.actor = patch.value.actor;
      if (patch.value.requester !== undefined) item.requester = patch.value.requester;
      if (item.status === "active") {
        if (patch.value.dueChange.mode === "clear") item.dueAt = null;
        if (patch.value.dueChange.mode === "set") item.dueAt = resolvePatchDueAt(patch, refs, context.messagesById, context.timeZone);
      }
    }
    item.evidenceGroups.push(evidenceGroup(patch, refs));
    item.updatedAtMessageId = Math.max(item.updatedAtMessageId, newestMessageId(refs));
    normalized.value = structuredClone(item);
    normalized.evidenceRefs = refs;
    return { normalized, tombstones: replacedEvidence };
  }
  return { rejectReason: "schema_invalid" };
}

function conflictKey(section, patch) {
  if (["setField", "clearField"].includes(patch.op)) return `${section}:field:${patch.path}`;
  if (patch.itemId) return `${section}:item:${patch.itemId}`;
  if (patch.itemIds) return patch.itemIds.map((id) => `${section}:item:${id}`);
  return null;
}

function reduceProposal({ state, task, proposal, observedMessages, databaseMessages, now = task.now, timeZone = "UTC", config, lifecycleAnchors = {}, idFactory = () => crypto.randomUUID(), identities = {}, protectedItemIds = [] }) {
  assertMemoryState(state);
  const original = structuredClone(state);
  const working = structuredClone(state);
  const events = [];
  const tombstones = [];
  const cleanupEvents = [];
  const seen = new Set();
  const messagesById = new Map(databaseMessages.map((message) => [message.id, message]));
  const patchIds = structuredClone(identities.patchIds || {});
  const itemIds = structuredClone(identities.itemIds || {});
  const protectedIds = new Set(protectedItemIds);
  const context = { idFactory, itemIds, messagesById, timeZone, cleanupEvents, nowMs: new Date(now).getTime() };

  for (const section of task.targetSections) {
    const result = proposal.sectionResults[section];
    if (result.status === "noop") {
      events.push({ eventKind: "proposal_decision", section, targetKey: task.targetKey, decision: "noop", patchId: null, op: null, evidenceKind: null, itemId: null, mergedFromItemIds: null, resultItemId: null, rejectReason: null, patchSummary: null, normalizedOperation: null });
      continue;
    }
    for (const [patchIndex, patch] of result.patches.entries()) {
      const identityKey = `${section}:${patchIndex}`;
      const patchId = patchIds[identityKey] || idFactory();
      patchIds[identityKey] = patchId;
      const schema = validatePatch(patch, section, { maintenance: task.mode === "maintenance", proposer: task.proposer });
      if (!schema.ok) {
        const reason = schema.errors.some((error) => error.path.endsWith(".quote") && error.message.includes("200")) ? "quote_too_long" : "schema_invalid";
        events.push(rejected(section, patch, patchId, reason));
        continue;
      }
      let refs = [];
      if (patch.op !== "mergeItems") {
        const evidence = validateEvidenceRefs({ patch, task, observedMessages, databaseMessages, quoteConfig: config.quote });
        if (!evidence.ok) { events.push(rejected(section, patch, patchId, evidence.reason)); continue; }
        refs = evidence.refs;
      }
      if (!isPolicyAllowed(section, patch.op, patch.evidenceKind)) { events.push(rejected(section, patch, patchId, "policy_not_allowed")); continue; }
      if (patch.op === "mergeItems" && patch.itemIds.some((itemId) => protectedIds.has(itemId))) {
        events.push(rejected(section, patch, patchId, "item_protected_by_pending_proposal"));
        continue;
      }
      const keys = [].concat(conflictKey(section, patch) || []);
      if (keys.some((key) => seen.has(key))) { events.push(rejected(section, patch, patchId, "invalid_state_transition")); continue; }
      const applied = applyPatch(working, section, patch, refs, context, identityKey);
      if (applied.rejectReason) { events.push(rejected(section, patch, patchId, applied.rejectReason)); continue; }
      keys.forEach((key) => seen.add(key));
      if (applied.tombstones) tombstones.push(...applied.tombstones);
      events.push({ ...eventBase(section, patch, "accepted", patchId), resultItemId: applied.resultItemId || null, normalizedOperation: applied.normalized });
    }
  }

  const effectiveAnchors = deriveLifecycleAnchors(working, lifecycleAnchors, messagesById);
  const lifecycle = normalizeLifecycle(working, effectiveAnchors, now, config);
  const acceptedSections = events.filter((event) => event.decision === "accepted").map((event) => event.section);
  const violation = findCapacityViolation(lifecycle.state, config, [...new Set(acceptedSections)]);
  if (violation) {
    const trigger = events.findLast((event) => event.decision === "accepted" && event.section === violation.section);
    return {
      outcome: "deferred", state: original, tombstones: [], cleanupEvents: [], capacityViolation: violation,
      events: [{ ...trigger, decision: "deferred", resultItemId: null, normalizedOperation: null }], snapshot: null,
      identities: { patchIds, itemIds },
    };
  }

  const finalState = lifecycle.state;
  finalState.meta.revision = state.meta.revision + 1;
  if (task.mode === "normal") finalState.meta.targetCursors[task.targetKey] = task.targetMessageId;
  assertMemoryState(finalState);
  const allEvents = [...events, ...cleanupEvents, ...lifecycle.events];
  const seenTombstones = new Set();
  const committedTombstones = tombstones.flatMap((entry) => {
    const key = `${entry.messageId}:${entry.contentHash}`;
    if (seenTombstones.has(key)) return [];
    seenTombstones.add(key);
    return [{ ...entry, userId: task.userId, presetId: task.presetId, createdRevision: finalState.meta.revision }];
  });
  return { outcome: "committable", state: finalState, events: allEvents, tombstones: committedTombstones, cleanupEvents: [...cleanupEvents, ...lifecycle.events], capacityViolation: null, snapshot: structuredClone(finalState), identities: { patchIds, itemIds } };
}

module.exports = { reduceProposal, sectionItems, SECTION_TARGETS };
