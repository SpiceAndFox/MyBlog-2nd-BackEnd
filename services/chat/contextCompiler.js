const { buildRecentWindowContext } = require("./context/buildRecentWindowContext");
const { buildMemorySnapshot } = require("./context/buildMemorySnapshot");
const { buildGapBridge } = require("./context/buildGapBridge");
const { buildContextSegments } = require("./context/segmentRegistry");
const { buildTimeContextState } = require("./context/buildTimeContextState");
const { normalizeText, normalizeMessageId } = require("./context/helpers");
const { scheduleAssistantGistBackfill } = require("./memory/gistPipeline");
const { retrieveChatRagContext } = require("./rag/retriever");

function readCurrentUserContent({ recent } = {}) {
  const messages = Array.isArray(recent?.messages) ? recent.messages : [];
  if (!messages.length) return "";
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  return normalizeText(last.content).trim();
}

async function compileChatContextMessages({ userId, presetId, systemPrompt, upToMessageId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const recentWindow = await buildRecentWindowContext({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    upToMessageId,
  });

  const recentCandidates = recentWindow.recentCandidates;
  const recent = recentWindow.recent;
  const selectedBeforeUserBoundary = recentWindow.selectedBeforeUserBoundary;
  const needsMemory = recentWindow.needsMemory;
  const recentGistBackfillCandidates = recentWindow.gistBackfillCandidates;

  const recentGistBackfill = scheduleAssistantGistBackfill({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    gistBackfillCandidates: recentGistBackfillCandidates,
  });
  if (recent?.stats?.assistantAntiEcho) {
    recent.stats.assistantAntiEcho.gistBackfill = recentGistBackfill;
  }

  const recentWindowStartMessageId = normalizeMessageId(recent.stats.windowStartMessageId);

  const memorySnapshot = await buildMemorySnapshot({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    recentWindowStartMessageId,
  });
  const memory = memorySnapshot.memory;
  const summarizedUntilMessageId = memorySnapshot.summarizedUntilMessageId;
  const rollingSummaryEnabled = memorySnapshot.rollingSummaryEnabled;
  const coreMemoryEnabled = memorySnapshot.coreMemoryEnabled;
  const coreMemoryText = memorySnapshot.coreMemoryText;
  const coreMemoryChars = memorySnapshot.coreMemoryChars;

  const gapBridge = await buildGapBridge({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    memory,
    recentWindowStartMessageId,
    summarizedUntilMessageId,
  });

  const gapGistBackfill = scheduleAssistantGistBackfill({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    gistBackfillCandidates: gapBridge?.gistBackfillCandidates,
  });
  if (gapBridge?.stats?.assistantAntiEcho) {
    gapBridge.stats.assistantAntiEcho.gistBackfill = gapGistBackfill;
  }

  const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
  const timeContext = buildTimeContextState({ recentCandidates });
  const ragContext = await retrieveChatRagContext({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    query: readCurrentUserContent({ recent }),
    beforeMessageId: summarizedUntilMessageId,
  });

  const compiled = buildContextSegments({
    systemPrompt: normalizedSystemPrompt,
    coreMemoryEnabled,
    coreMemoryText,
    coreMemoryChars,
    rollingSummaryEnabled,
    memory,
    ragContext,
    gapBridge,
    recent,
    timeContext,
  });

  return {
    messages: compiled,
    needsMemory,
    segments: {
      systemPromptChars: normalizedSystemPrompt.length,
      coreMemoryChars: coreMemoryEnabled ? coreMemoryChars : 0,
      rollingSummaryChars: rollingSummaryEnabled ? String(memory.rollingSummary || "").length : 0,
      rag: ragContext?.stats || null,
      gapBridge: gapBridge ? gapBridge.stats : null,
      recentWindow: {
        ...recent.stats,
        candidates: recentCandidates.length,
        selectedBeforeUserBoundary,
        needsMemory,
      },
    },
    memory: memory
      ? {
          summarizedUntilMessageId: memory.summarizedUntilMessageId,
          dirtySinceMessageId: memory.dirtySinceMessageId,
          rebuildRequired: memory.rebuildRequired,
        }
      : null,
    rag: ragContext
      ? {
          enabled: Boolean(ragContext.enabled),
          sources: Array.isArray(ragContext.sources) ? ragContext.sources : [],
          stats: ragContext.stats || null,
        }
      : null,
  };
}

module.exports = {
  compileChatContextMessages,
};
