const { TARGET_KEYS } = require("../contracts/constants");
const { codePointLength } = require("./capacity");

function messageId(message) {
  const id = Number(message?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Context source message id must be a positive safe integer");
  return id;
}

function normalizeSourceMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("Context source messages must be an array");
  return messages.map((message) => {
    const role = String(message?.role || "").trim();
    if (!["user", "assistant"].includes(role)) throw new Error("Context source role must be user or assistant");
    return { ...message, id: messageId(message), role, content: String(message?.content ?? "") };
  }).sort((left, right) => left.id - right.id);
}

function selectRecentWindow(messages, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("recentWindow maxChars must be a positive integer");
  const source = normalizeSourceMessages(messages);
  const candidateChars = source.reduce((sum, message) => sum + codePointLength(message.content), 0);
  if (candidateChars <= maxChars) {
    return { messages: source, needsMemory: false, candidateChars, selectedChars: candidateChars, droppedToUserBoundary: 0 };
  }

  const selected = [];
  let selectedChars = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    const chars = codePointLength(message.content);
    if (selected.length && selectedChars + chars > maxChars) break;
    selected.unshift(message);
    selectedChars += chars;
  }

  let droppedToUserBoundary = 0;
  while (selected.length > 1 && selected[0].role !== "user") {
    selectedChars -= codePointLength(selected.shift().content);
    droppedToUserBoundary += 1;
  }
  return { messages: selected, needsMemory: true, candidateChars, selectedChars, droppedToUserBoundary };
}

function cursorFor(state, targetKey) {
  const value = Number(state?.meta?.targetCursors?.[targetKey] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid cursor for target ${targetKey}`);
  return value;
}

function buildGapBridgeCoverage({ messages, state, recentWindowStartMessageId, maxRawChars, retainedMessages }) {
  if (!Number.isSafeInteger(maxRawChars) || maxRawChars <= 0) throw new Error("GapBridge maxRawChars must be positive");
  if (!Number.isSafeInteger(retainedMessages) || retainedMessages <= 0) throw new Error("GapBridge retainedMessages must be positive");
  const source = normalizeSourceMessages(messages);
  const start = Number(recentWindowStartMessageId);
  if (!Number.isSafeInteger(start) || start <= 0) return { messages: [], diagnostics: [], gapsByTarget: {} };

  const gapsByTarget = {};
  const union = new Map();
  for (const targetKey of TARGET_KEYS) {
    const cursor = cursorFor(state, targetKey);
    const gap = source.filter((message) => cursor < message.id && message.id < start);
    gapsByTarget[targetKey] = gap;
    for (const message of gap) {
      const existing = union.get(message.id) || { ...message, targetKeys: [] };
      existing.targetKeys.push(targetKey);
      union.set(message.id, existing);
    }
  }

  const all = [...union.values()].sort((left, right) => left.id - right.id);
  const retainedReversed = [];
  let retainedChars = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index];
    const chars = codePointLength(message.content);
    if (retainedReversed.length >= retainedMessages || retainedChars + chars > maxRawChars) continue;
    retainedReversed.push(message);
    retainedChars += chars;
  }
  const retained = retainedReversed.reverse();
  const retainedIds = new Set(retained.map((message) => message.id));
  const diagnostics = [];
  for (const targetKey of TARGET_KEYS) {
    const gap = gapsByTarget[targetKey];
    const kept = gap.filter((message) => retainedIds.has(message.id));
    const omitted = gap.filter((message) => !retainedIds.has(message.id));
    if (!omitted.length) continue;
    diagnostics.push({
      subjectKind: "target", subjectKey: targetKey, diagnosticType: "gap_bridge_omitted",
      targetCursor: cursorFor(state, targetKey), recentWindowStart: start,
      originalGapCount: gap.length,
      originalGapChars: gap.reduce((sum, message) => sum + codePointLength(message.content), 0),
      retainedBoundary: kept.length ? kept[0].id : null, retainedCount: kept.length,
      omittedCount: omitted.length,
      omittedChars: omitted.reduce((sum, message) => sum + codePointLength(message.content), 0),
      omittedUpperMessageId: omitted[omitted.length - 1].id, truncated: true,
    });
  }
  return { messages: retained, diagnostics, gapsByTarget, stats: { originalCount: all.length, originalChars: all.reduce((sum, item) => sum + codePointLength(item.content), 0), retainedCount: retained.length, retainedChars, omittedCount: all.length - retained.length } };
}

function assessProjectionCoverage(checkpoint, { sourceGeneration, recentWindowStartMessageId }) {
  const requiredBoundary = Math.max(0, Number(recentWindowStartMessageId || 1) - 1);
  if (!checkpoint) return null;
  const processedGeneration = Number(checkpoint.processedGeneration ?? checkpoint.processed_generation);
  const processedBoundary = Number(checkpoint.processedBoundaryMessageId ?? checkpoint.processed_boundary_message_id ?? 0);
  if (processedGeneration !== sourceGeneration) return { queryHealth: "rebuilding", requiredBoundary, processedBoundary };
  if (processedBoundary < requiredBoundary) return { queryHealth: "degraded", requiredBoundary, processedBoundary };
  return { queryHealth: "healthy", requiredBoundary, processedBoundary };
}

module.exports = { selectRecentWindow, buildGapBridgeCoverage, assessProjectionCoverage, normalizeSourceMessages };
