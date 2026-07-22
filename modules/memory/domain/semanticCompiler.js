const { isDeepStrictEqual } = require("node:util");
const {
  normalizeSourceRefs,
  validateRendererArtifact,
  validateSemanticResult,
  validateCompiledProposal,
} = require("../contracts");
const { resolveDueAt } = require("./calendar");
const { dueAtRequiresMessageAnchor } = require("../contracts/dueAt");

class SemanticCompileError extends Error {
  constructor(reason, detail = {}) {
    super(`Memory Semantic compile failed: ${reason}`);
    this.name = "SemanticCompileError";
    this.code = reason;
    this.reason = reason;
    this.detail = detail;
  }
}

function fail(reason, detail) { throw new SemanticCompileError(reason, detail); }

function sectionItems(state, section) {
  if (["todos", "standingAgreements", "recentEpisodes"].includes(section)) return state?.working?.[section];
  return state?.longTerm?.[section];
}

function resolveStateEntry(state, entry) {
  if (entry.section === "scene") return state?.current?.scene?.[entry.path] || null;
  return (sectionItems(state, entry.section) || []).find((item) => item.id === entry.itemId) || null;
}

function resolveWritableRef(artifact, state, section, ref) {
  const entry = artifact.refMap.writable[ref];
  if (!entry || entry.section !== section || artifact.refMap.readOnly[ref]) fail("ref_resolution_failed", { selector: "ref", ref, section });
  if (!resolveStateEntry(state, entry)) fail("ref_resolution_failed", { selector: "ref", ref, section, reason: "target_missing" });
  return entry;
}

function resolveSupportRef(artifact, state, ref) {
  const entry = artifact.refMap.readOnly[ref];
  if (!entry || artifact.refMap.writable[ref]) fail("ref_resolution_failed", { selector: "supportRef", ref });
  const authoritative = resolveStateEntry(state, entry);
  if (!authoritative) fail("ref_resolution_failed", { selector: "supportRef", ref, reason: "support_missing" });
  const actualRefs = normalizeSourceRefs(authoritative.sourceRefs);
  if (!actualRefs.length || !isDeepStrictEqual(actualRefs, entry.sourceRefs)) {
    fail("ref_resolution_failed", { selector: "supportRef", ref, reason: "support_changed" });
  }
  return entry;
}

function validateCompilationInput({ artifact, semanticResult, baseState }) {
  const artifactValidation = validateRendererArtifact(artifact);
  if (!artifactValidation.ok) fail("compile_invariant_failed", { reason: "artifact_invalid", errors: artifactValidation.errors.slice(0, 8) });
  const semanticValidation = validateSemanticResult(semanticResult, artifact);
  if (!semanticValidation.ok) fail("semantic_schema_invalid", { errors: semanticValidation.errors.slice(0, 8) });
  if (!baseState) fail("compile_invariant_failed", { reason: "base_state_missing" });
  if (Object.values(semanticResult.sectionResults).some((result) => ["unable_to_decide", "unable_to_compact"].includes(result.status))) {
    fail("compile_invariant_failed", { reason: "unable_result_is_not_compilable" });
  }
}

function collectSourceSelectors(artifact, state, semanticResult) {
  const directIds = new Set();
  const supportRefs = new Map();
  for (const [section, result] of Object.entries(semanticResult.sectionResults)) {
    if (result.status !== "changes") continue;
    for (const change of result.changes) {
      if (change.action === "merge") {
        for (const ref of change.refs) resolveWritableRef(artifact, state, section, ref);
        continue;
      }
      if (change.action !== "add") resolveWritableRef(artifact, state, section, change.ref);
      for (const id of change.evidenceMessageIds || []) directIds.add(id);
      for (const ref of change.supportRefs || []) supportRefs.set(ref, resolveSupportRef(artifact, state, ref));
    }
  }
  return { directIds, supportRefs };
}

function semanticSourceRequest({ artifact, semanticResult, baseState } = {}) {
  validateCompilationInput({ artifact, semanticResult, baseState });
  const selectors = collectSourceSelectors(artifact, baseState, semanticResult);
  const supportSourceRefs = [...selectors.supportRefs.values()].flatMap((entry) => entry.sourceRefs);
  const ids = [...new Set([...selectors.directIds, ...supportSourceRefs.map((ref) => ref.messageId)])].sort((a, b) => a - b);
  return { ...selectors, supportSourceRefs, ids };
}

function normalizeSourceMessage(row) {
  return {
    id: Number(row?.id ?? row?.messageId ?? row?.message_id),
    role: row?.role,
    createdAt: row?.createdAt ?? row?.created_at,
    contentHash: row?.contentHash ?? row?.content_hash,
    userId: row?.userId ?? row?.user_id,
    presetId: row?.presetId ?? row?.preset_id,
  };
}

function validateSemanticSourceMessages({ artifact, userId, presetId, request, sourceMessages = [] }) {
  const byId = new Map(sourceMessages.map((row) => {
    const message = normalizeSourceMessage(row);
    return [message.id, message];
  }));
  if (byId.size !== request.ids.length || request.ids.some((id) => !byId.has(id))) fail("source_validation_failed", { reason: "message_missing" });
  for (const id of request.ids) {
    const message = byId.get(id);
    if (!["user", "assistant"].includes(message.role)) fail("source_validation_failed", { reason: "role_invalid", messageId: id });
    if (!message.createdAt || Number.isNaN(new Date(message.createdAt).getTime())) fail("source_validation_failed", { reason: "created_at_invalid", messageId: id });
    if (message.userId !== undefined && Number(message.userId) !== Number(userId)) fail("source_validation_failed", { reason: "scope_mismatch", messageId: id });
    if (message.presetId !== undefined && String(message.presetId) !== String(presetId)) fail("source_validation_failed", { reason: "scope_mismatch", messageId: id });
    if (request.directIds.has(id)) {
      const meta = artifact.messageMeta[String(id)];
      if (!meta || meta.role !== message.role || meta.contentHash !== message.contentHash
        || new Date(meta.createdAt).toISOString() !== new Date(message.createdAt).toISOString()) {
        fail("source_validation_failed", { reason: "direct_metadata_mismatch", messageId: id });
      }
    }
  }
  for (const ref of request.supportSourceRefs) {
    if (byId.get(ref.messageId)?.contentHash !== ref.contentHash) fail("source_validation_failed", { reason: "support_hash_mismatch", messageId: ref.messageId });
  }
  return byId;
}

function sourcesForChange(change, artifact, messageById) {
  const refs = [];
  for (const id of change.evidenceMessageIds || []) {
    const message = messageById.get(id);
    refs.push({ messageId: id, contentHash: message.contentHash });
  }
  for (const supportRef of change.supportRefs || []) refs.push(...artifact.refMap.readOnly[supportRef].sourceRefs);
  const normalized = normalizeSourceRefs(refs);
  if (!normalized.length) fail("source_validation_failed", { reason: "empty_expanded_sources" });
  return normalized;
}

function resolveSemanticDueAt(expression, change, messageById, task) {
  if (!expression) return null;
  let anchor = task.now;
  if (dueAtRequiresMessageAnchor(expression)) {
    if (!change.anchorMessageId || !change.evidenceMessageIds?.includes(change.anchorMessageId)) fail("date_anchor_invalid", { reason: "anchor_not_direct" });
    const message = messageById.get(change.anchorMessageId);
    if (!message) fail("date_anchor_invalid", { reason: "anchor_missing" });
    anchor = message.createdAt;
  }
  try { return resolveDueAt(expression, anchor, task.userTimeZone); }
  catch (error) { fail("date_anchor_invalid", { reason: "date_resolution_failed", message: error.message }); }
}

function compileTodoValue(change, messageById, task) {
  if (change.action === "add") return {
    text: change.text,
    actor: change.actor,
    requester: change.requester,
    dueAt: change.dueAt ? resolveSemanticDueAt(change.dueAt, change, messageById, task) : null,
  };
  const value = { dueChange: { mode: change.dueChange.mode } };
  for (const field of ["text", "actor", "requester"]) if (change[field] !== undefined) value[field] = change[field];
  if (change.dueChange.mode === "set") value.dueChange.dueAt = resolveSemanticDueAt(change.dueChange.dueAt, change, messageById, task);
  return value;
}

function compileChange({ change, section, artifact, state, messageById, task }) {
  if (change.action === "merge") {
    const entries = change.refs.map((ref) => resolveWritableRef(artifact, state, section, ref));
    return { op: "mergeItems", itemIds: entries.map((entry) => entry.itemId), value: { text: change.text } };
  }
  const sourceRefs = sourcesForChange(change, artifact, messageById);
  if (section === "scene") {
    const target = resolveWritableRef(artifact, state, section, change.ref);
    if (["clear", "forget"].includes(change.action)) return { op: "clearField", path: target.path, sourceRefs };
    return { op: "setField", path: target.path, value: change.text, sourceRefs };
  }
  let target = null;
  if (change.action !== "add") target = resolveWritableRef(artifact, state, section, change.ref);
  if (change.action === "add") {
    const value = section === "todos" ? compileTodoValue(change, messageById, task) : { text: change.text };
    return { op: "addItem", value, sourceRefs };
  }
  if (["update", "correct"].includes(change.action)) {
    const value = section === "todos" ? compileTodoValue(change, messageById, task) : { text: change.text };
    return { op: "updateItem", itemId: target.itemId, value, sourceRefs };
  }
  const terminalOps = {
    forget: "forgetItem",
    complete: "completeTodo",
    cancel: section === "todos" ? "cancelTodo" : "cancelAgreement",
    expire: "expireTodo",
  };
  const op = terminalOps[change.action];
  if (!op) fail("compile_invariant_failed", { section, action: change.action });
  return { op, itemId: target.itemId, sourceRefs };
}

function compileSemanticResult({ artifact, semanticResult, baseState, sourceMessages = [], userId, presetId } = {}) {
  const request = semanticSourceRequest({ artifact, semanticResult, baseState });
  const messageById = validateSemanticSourceMessages({ artifact, userId, presetId, request, sourceMessages });
  const task = artifact.publicInput.task;
  const sectionResults = {};
  for (const [section, result] of Object.entries(semanticResult.sectionResults)) {
    if (result.status === "noop") { sectionResults[section] = { status: "noop" }; continue; }
    sectionResults[section] = {
      status: "patches",
      patches: result.changes.map((change) => compileChange({ change, section, artifact, state: baseState, messageById, task })),
    };
  }
  const compiled = { tickId: semanticResult.tickId, proposer: semanticResult.proposer, sectionResults };
  const validation = validateCompiledProposal(compiled, task);
  if (!validation.ok) fail("compile_invariant_failed", { reason: "compiled_schema_invalid", errors: validation.errors.slice(0, 8) });
  return compiled;
}

function compiledProposalSourceRequest({ proposal, task, baseState } = {}) {
  if (!baseState) fail("compile_invariant_failed", { reason: "base_state_missing" });
  const validation = validateCompiledProposal(proposal, task);
  if (!validation.ok) fail("compile_invariant_failed", { reason: "compiled_schema_invalid", errors: validation.errors.slice(0, 8) });
  const refs = [];
  for (const [section, result] of Object.entries(proposal.sectionResults)) {
    if (result.status !== "patches") continue;
    for (const patch of result.patches) {
      refs.push(...(patch.sourceRefs || []));
      if (section === "scene") {
        const entry = baseState.current?.scene?.[patch.path];
        if (!entry) fail("ref_resolution_failed", { section, path: patch.path, reason: "target_missing" });
        refs.push(...(entry.sourceRefs || []));
        continue;
      }
      const items = sectionItems(baseState, section) || [];
      for (const itemId of [patch.itemId, ...(patch.itemIds || [])].filter(Boolean)) {
        const item = items.find((candidate) => candidate.id === itemId);
        if (!item) fail("ref_resolution_failed", { section, itemId, reason: "target_missing" });
        refs.push(...(item.sourceRefs || []));
      }
    }
  }
  const expectedRefs = normalizeSourceRefs(refs);
  return { expectedRefs, ids: expectedRefs.map((ref) => ref.messageId) };
}

function revalidateCompiledProposal({ proposal, task, baseState, sourceMessages = [], userId, presetId } = {}) {
  const request = compiledProposalSourceRequest({ proposal, task, baseState });
  if (!request.ids.length) return true;
  const byId = new Map(sourceMessages.map((row) => {
    const message = normalizeSourceMessage(row);
    return [message.id, message];
  }));
  if (byId.size !== request.ids.length || request.ids.some((id) => !byId.has(id))) fail("source_validation_failed", { reason: "message_missing" });
  for (const ref of request.expectedRefs) {
    const message = byId.get(ref.messageId);
    if (!message || message.contentHash !== ref.contentHash) fail("source_validation_failed", { reason: "source_hash_mismatch", messageId: ref.messageId });
    if (message.userId !== undefined && Number(message.userId) !== Number(userId)) fail("source_validation_failed", { reason: "scope_mismatch", messageId: ref.messageId });
    if (message.presetId !== undefined && String(message.presetId) !== String(presetId)) fail("source_validation_failed", { reason: "scope_mismatch", messageId: ref.messageId });
  }
  return true;
}

module.exports = {
  SemanticCompileError,
  collectSourceSelectors,
  compileSemanticResult,
  compiledProposalSourceRequest,
  normalizeSourceMessage,
  revalidateCompiledProposal,
  resolveStateEntry,
  sectionItems,
  semanticSourceRequest,
};
