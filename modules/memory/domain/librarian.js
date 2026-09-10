const crypto = require("node:crypto");
const { assertItemLimits } = require("./writeGuards");
const {
  LIBRARIAN_SECTIONS,
  LIBRARIAN_TARGET_KEY,
  assertMemoryState,
  normalizeSourceRefs,
  validateLibrarianSemanticResult,
} = require("../contracts");
const { findCapacityViolation } = require("./capacity");
const {
  ITEM_ID_ALLOCATION_ERROR_CODE,
  allocateMemoryItemId,
} = require("./itemIds");

function librarianError(reason, detail = {}) {
  const error = new Error(`Invalid Librarian proposal: ${reason}`);
  error.code = "MEMORY_LIBRARIAN_PROPOSAL_INVALID";
  error.reason = reason;
  error.detail = detail;
  return error;
}
function fail(reason, detail) { throw librarianError(reason, detail); }

function sectionItems(state, section) {
  if (!LIBRARIAN_SECTIONS.includes(section)) fail("section_not_allowed", { section });
  return section === "standingAgreements" ? state.working.standingAgreements : state.longTerm[section];
}

function resolveRef(artifact, state, ref) {
  const entry = artifact.refMap.writable[ref];
  if (!entry || !LIBRARIAN_SECTIONS.includes(entry.section)) fail("ref_resolution_failed", { ref });
  const item = sectionItems(state, entry.section).find((candidate) => candidate.id === entry.itemId);
  if (!item) fail("ref_resolution_failed", { ref, itemId: entry.itemId });
  return { ref, section: entry.section, itemId: entry.itemId };
}

function resolveEvidence(artifact, state, refs, owners) {
  const sources = [];
  for (const ref of refs || []) {
    const entry = artifact.refMap.readOnly[ref];
    if (!entry || (owners && !owners.some(owner => owner.itemId === entry.itemId && owner.section === entry.section))) fail("evidence_owner_invalid", { ref });
    const item = sectionItems(state, entry.section).find(item => item.id === entry.itemId);
    if (!entry.sourceRefs?.length || !entry.sourceRefs.every(source => item?.sourceRefs.some(current => current.messageId === source.messageId && current.contentHash === source.contentHash))) fail("evidence_ref_invalid", { ref });
    sources.push(...entry.sourceRefs);
  }
  const result = normalizeSourceRefs(sources);
  if (!result.length) fail("evidence_required");
  return result;
}

function compileLibrarianProposal({ artifact, semanticResult, baseState } = {}) {
  assertMemoryState(baseState);
  const validation = validateLibrarianSemanticResult(semanticResult, artifact);
  if (!validation.ok) fail("semantic_schema_invalid", { errors: validation.errors });
  if (semanticResult.status === "noop") {
    return { tickId: semanticResult.tickId, proposer: semanticResult.proposer, status: "noop" };
  }
  const operations = semanticResult.operations.map((operation) => {
    if (operation.action === "move") {
      return { op: "librarianMove", source: resolveRef(artifact, baseState, operation.ref), toSection: operation.toSection };
    }
    if (operation.action === "merge") {
      const sources = operation.refs.map(ref => resolveRef(artifact, baseState, ref));
      return {
        op: "librarianMerge",
        sources,
        sourceRefs: resolveEvidence(artifact, baseState, operation.supportRefs, sources),
        toSection: operation.toSection,
        text: operation.text,
      };
    }
    if (operation.action === "remove") {
      return {
        op: "librarianDropDuplicate",
        keeper: resolveRef(artifact, baseState, operation.keeperRef),
        duplicates: [resolveRef(artifact, baseState, operation.ref)],
      };
    }
    if (["revise", "correct"].includes(operation.action)) {
      return { op: operation.action === "revise" ? "librarianRevise" : "librarianCorrect",
        source: resolveRef(artifact, baseState, operation.ref), text: operation.text,
        sourceRefs: resolveEvidence(artifact, baseState, operation.supportRefs) };
    }
    if (operation.action === "split") {
      return {
        op: "librarianSplitMove",
        source: resolveRef(artifact, baseState, operation.ref),
        parts: operation.parts.map(part => ({ toSection: part.toSection, text: part.text, sourceRefs: resolveEvidence(artifact, baseState, part.supportRefs, [resolveRef(artifact, baseState, operation.ref)]) })),
      };
    }
    fail("compile_invariant_failed", { action: operation.action });
  });
  return { tickId: semanticResult.tickId, proposer: semanticResult.proposer, status: "operations", operations };
}

function findItem(state, selector) {
  const items = sectionItems(state, selector.section);
  const index = items.findIndex((item) => item.id === selector.itemId);
  if (index < 0) fail("item_not_found", selector);
  return { items, index, item: items[index] };
}

function nextLibrarianItemId(state, section, idFactory) {
  try {
    return allocateMemoryItemId(state, section, idFactory);
  } catch (error) {
    if (error?.code === ITEM_ID_ALLOCATION_ERROR_CODE) fail("id_allocation_failed", { section });
    throw error;
  }
}

function eventFor(operation, normalizedOperation, index) {
  const sourceIds = normalizedOperation.sources?.map((entry) => entry.itemId)
    || normalizedOperation.duplicates?.map((entry) => entry.itemId)
    || null;
  const itemId = normalizedOperation.source?.itemId || normalizedOperation.keeper?.itemId || null;
  const resultItemId = normalizedOperation.result?.id || null;
  const section = normalizedOperation.toSection
    || normalizedOperation.keeper?.section
    || normalizedOperation.parts?.[0]?.toSection
    || normalizedOperation.source?.section;
  return {
    eventKind: "proposal_decision",
    section,
    targetKey: LIBRARIAN_TARGET_KEY,
    decision: "accepted",
    patchId: `librarian:${index + 1}`,
    op: operation.op,
    itemId,
    mergedFromItemIds: sourceIds,
    resultItemId,
    rejectReason: null,
    patchSummary: structuredClone(operation),
    normalizedOperation,
  };
}

function reduceLibrarianProposal({
  state,
  task,
  proposal,
  config,
  idFactory = () => crypto.randomUUID(),
} = {}) {
  assertMemoryState(state);
  if (task.baseRevision !== state.meta.revision || task.sourceGeneration !== state.meta.sourceGeneration) {
    fail("revision_mismatch", {
      expectedRevision: task.baseRevision,
      actualRevision: state.meta.revision,
      expectedGeneration: task.sourceGeneration,
      actualGeneration: state.meta.sourceGeneration,
    });
  }
  if (proposal.tickId !== task.tickId || proposal.proposer !== task.proposer) fail("compiled_metadata_mismatch");
  if (proposal.status === "noop") return { outcome: "noop", state: structuredClone(state), events: [], snapshot: null };
  if (proposal.status !== "operations" || !Array.isArray(proposal.operations) || !proposal.operations.length || proposal.operations.length > 6) fail("compiled_schema_invalid");

  const working = structuredClone(state);
  const events = [];
  const involved = new Set();
  const reserve = (selector) => {
    const key = selector.itemId;
    if (involved.has(key)) fail("operation_conflict", { itemId: key });
    involved.add(key);
  };

  proposal.operations.forEach((operation, index) => {
    if (operation.op === "librarianMove") {
      reserve(operation.source);
      const source = findItem(working, operation.source);
      if (operation.toSection === operation.source.section) fail("move_same_section");
      assertItemLimits(operation.toSection, source.item.text, source.item.sourceRefs, task);
      source.item.updatedAtMessageId = task.boundaryMessageId;
      source.items.splice(source.index, 1);
      sectionItems(working, operation.toSection).push(source.item);
      const normalized = {
        op: operation.op,
        source: { section: operation.source.section, itemId: source.item.id },
        toSection: operation.toSection,
        value: structuredClone(source.item),
      };
      events.push(eventFor(operation, normalized, index));
      return;
    }
    if (["librarianRevise", "librarianCorrect"].includes(operation.op)) {
      reserve(operation.source);
      const source = findItem(working, operation.source);
      assertItemLimits(operation.source.section, operation.text, operation.sourceRefs, task);
      source.item.text = operation.text;
      source.item.sourceRefs = structuredClone(operation.sourceRefs);
      source.item.updatedAtMessageId = task.boundaryMessageId;
      events.push(eventFor(operation, { op: operation.op, source: { section: operation.source.section, itemId: source.item.id }, value: structuredClone(source.item) }, index));
      return;
    }
    if (operation.op === "librarianMerge") {
      operation.sources.forEach(reserve);
      assertItemLimits(operation.toSection, operation.text, operation.sourceRefs, task);
      const resolved = operation.sources.map((selector) => ({ selector, ...findItem(working, selector) }));
      const refs = normalizeSourceRefs(operation.sourceRefs);
      if (!refs.every(ref => resolved.some(entry => entry.item.sourceRefs.some(current => current.messageId === ref.messageId && current.contentHash === ref.contentHash)))) fail("evidence_owner_invalid");
      const item = {
        id: nextLibrarianItemId(working, operation.toSection, idFactory),
        text: operation.text,
        sourceRefs: refs,
        createdAtMessageId: task.boundaryMessageId,
        updatedAtMessageId: task.boundaryMessageId,
      };
      for (const entry of resolved) {
        const current = findItem(working, entry.selector);
        current.items.splice(current.index, 1);
      }
      sectionItems(working, operation.toSection).push(item);
      const normalized = {
        op: operation.op,
        sources: operation.sources.map((entry) => ({ section: entry.section, itemId: entry.itemId })),
        toSection: operation.toSection,
        result: structuredClone(item),
      };
      events.push(eventFor(operation, normalized, index));
      return;
    }
    if (operation.op === "librarianDropDuplicate") {
      reserve(operation.keeper);
      operation.duplicates.forEach(reserve);
      const keeper = findItem(working, operation.keeper);
      const duplicateItems = operation.duplicates.map((selector) => ({ selector, ...findItem(working, selector) }));
      for (const entry of duplicateItems) {
        const current = findItem(working, entry.selector);
        current.items.splice(current.index, 1);
      }
      const normalized = {
        op: operation.op,
        keeper: { section: operation.keeper.section, itemId: keeper.item.id },
        duplicates: operation.duplicates.map((entry) => ({ section: entry.section, itemId: entry.itemId })),
        value: structuredClone(keeper.item),
      };
      events.push(eventFor(operation, normalized, index));
      return;
    }
    if (operation.op === "librarianSplitMove") {
      reserve(operation.source);
      if (!Array.isArray(operation.parts) || (operation.parts.length < 2 || operation.parts.length > 4)) fail("split_parts_invalid");
      const source = findItem(working, operation.source);
      operation.parts.forEach(part => {
        assertItemLimits(part.toSection, part.text, part.sourceRefs, task);
        if (!part.sourceRefs.every(ref => source.item.sourceRefs.some(current => current.messageId === ref.messageId && current.contentHash === ref.contentHash))) fail("evidence_owner_invalid");
      });
      source.items.splice(source.index, 1);
      const parts = operation.parts.map((part) => {
        const item = {
          id: nextLibrarianItemId(working, part.toSection, idFactory),
          text: part.text,
          sourceRefs: structuredClone(part.sourceRefs),
          createdAtMessageId: task.boundaryMessageId,
          updatedAtMessageId: task.boundaryMessageId,
        };
        sectionItems(working, part.toSection).push(item);
        return { toSection: part.toSection, value: structuredClone(item) };
      });
      const normalized = {
        op: operation.op,
        source: { section: operation.source.section, itemId: source.item.id },
        parts,
      };
      events.push(eventFor(operation, normalized, index));
      return;
    }
    fail("compiled_op_invalid", { op: operation.op });
  });

  const violation = findCapacityViolation(working, config, LIBRARIAN_SECTIONS);
  if (violation) fail("capacity_exceeded", violation);
  working.meta.revision = state.meta.revision + 1;
  assertMemoryState(working);
  return {
    outcome: "committable",
    state: working,
    events,
    snapshot: structuredClone(working),
  };
}

module.exports = {
  librarianError,
  sectionItems,
  compileLibrarianProposal,
  reduceLibrarianProposal,
};
