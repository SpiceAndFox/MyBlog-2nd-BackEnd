const { assertMemoryState } = require("../contracts/state");

function sourceKey(messageId, contentHash) {
  return `${Number(messageId)}\u0000${String(contentHash)}`;
}

function tombstoneKeySet(tombstones) {
  return new Set((tombstones || []).map((row) => sourceKey(
    row.message_id ?? row.messageId,
    row.content_hash ?? row.contentHash,
  )));
}

function refIsSuppressed(ref, keys) {
  return keys.has(sourceKey(ref.messageId, ref.contentHash));
}

function itemSurvivesSuppression(item, keys) {
  const groups = item.evidenceGroups || [];
  const hasSuppressed = groups.some((group) => group.refs.some((ref) => refIsSuppressed(ref, keys)));
  if (!hasSuppressed) return true;
  const newestSuppressed = Math.max(...groups.flatMap((group) => group.refs)
    .filter((ref) => refIsSuppressed(ref, keys)).map((ref) => ref.messageId));
  return groups.some((group) => ["user_correction", "assistant_correction"].includes(group.evidenceKind)
    && group.refs.some((ref) => !refIsSuppressed(ref, keys) && ref.messageId > newestSuppressed));
}

function filterRebuiltState(state, tombstones) {
  assertMemoryState(state);
  const keys = tombstoneKeySet(tombstones);
  if (!keys.size) return { state: structuredClone(state), removedItemIds: [] };
  const next = structuredClone(state);
  const removedItemIds = [];
  for (const [containerName, sections] of [["working", ["todos", "standingAgreements", "recentEpisodes"]], ["longTerm", ["milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"]]]) {
    for (const section of sections) {
      next[containerName][section] = next[containerName][section].filter((item) => {
        const keep = itemSurvivesSuppression(item, keys);
        if (!keep) removedItemIds.push(item.id);
        return keep;
      });
    }
  }
  for (const scene of [next.current.scene, next.current.previousScene].filter(Boolean)) {
    for (const [path, field] of Object.entries(scene)) {
      if (path === "expiredAt") continue;
      if (field.evidenceRef && refIsSuppressed(field.evidenceRef, keys)) {
        field.value = null;
        field.evidenceRef = null;
        field.updatedAtMessageId = null;
      }
    }
  }
  assertMemoryState(next);
  return { state: next, removedItemIds };
}

function sourceRefsForRagChunk(chunk) {
  const refs = chunk.sourceRefs ?? chunk.source_refs ?? chunk.metadata?.sourceRefs;
  return Array.isArray(refs) ? refs : [];
}

function filterRagChunks(chunks, tombstones) {
  const keys = tombstoneKeySet(tombstones);
  return (chunks || []).filter((chunk) => {
    const refs = sourceRefsForRagChunk(chunk);
    return refs.length > 0 && !refs.some((ref) => refIsSuppressed(ref, keys));
  });
}

function filterRecall({ evidenceGroups = [], rawMessages = [] }, tombstones) {
  const keys = tombstoneKeySet(tombstones);
  const messages = rawMessages.filter((message) => !keys.has(sourceKey(message.id ?? message.messageId, message.contentHash)));
  const messageKeys = new Set(messages.map((message) => sourceKey(message.id ?? message.messageId, message.contentHash)));
  const groups = evidenceGroups.flatMap((group) => {
    const refs = group.refs.filter((ref) => !refIsSuppressed(ref, keys) && messageKeys.has(sourceKey(ref.messageId, ref.contentHash)));
    return refs.length ? [{ ...group, refs }] : [];
  });
  return { evidenceGroups: groups, rawMessages: messages };
}

module.exports = { sourceKey, tombstoneKeySet, refIsSuppressed, itemSurvivesSuppression, filterRebuiltState, filterRagChunks, filterRecall };
