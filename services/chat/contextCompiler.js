const crypto = require("node:crypto");
const { buildRecentWindowContext } = require("./context/buildRecentWindowContext");
const { buildMemorySnapshot } = require("./context/buildMemorySnapshot");
const { buildGapBridge } = require("./context/buildGapBridge");
const { buildContextSegments } = require("./context/segmentRegistry");
const { buildTimeContextState } = require("./context/buildTimeContextState");
const { normalizeText, normalizeMessageId } = require("./context/helpers");
const { scheduleAssistantGistBackfill } = require("./memory/gistPipeline");
const { retrieveChatRagContext } = require("./rag/retriever");
const { chatConfig, chatMemoryConfig, memoryV2Config } = require("../../config");
const { createDefaultMemoryContextAssembly } = require("../../modules/memory");
const { logger } = require("../../logger");

let memoryV2Assembler = null;
function getMemoryV2Assembler() {
  if (!memoryV2Assembler) memoryV2Assembler = createDefaultMemoryContextAssembly({ config: memoryV2Config, recentWindowMaxChars: chatConfig.recentWindowMaxChars, onBackgroundError: (error) => logger.error("memory_v2_housekeeping_failed", { error }) });
  return memoryV2Assembler;
}

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

  if (memoryV2Config.enabled) {
    const contextV2 = await getMemoryV2Assembler()({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      upToMessageId,
      requestId: crypto.randomUUID(),
    });
    const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
    const recent = contextV2.recent;
    const requiredBoundary = Math.max(0, Number(recent.stats.windowStartMessageId || 1) - 1);
    const ragProjection = contextV2.projectionCoverage.find((entry) => entry.projectionKey === "rag");
    const ragBoundary = ragProjection ? Math.min(requiredBoundary, ragProjection.processedBoundary) : requiredBoundary;
    const ragContext = !ragProjection || ragProjection.queryHealth === "rebuilding"
      ? { enabled: true, messages: [], sources: [], stats: { reason: ragProjection ? "projection_rebuilding" : "projection_checkpoint_missing" } }
      : await retrieveChatRagContext({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        query: readCurrentUserContent({ recent }),
        beforeMessageId: ragBoundary,
      });
    if (ragProjection && ragProjection.queryHealth !== "healthy" && ragContext?.messages?.length) {
      ragContext.messages = ragContext.messages.map((message) => ({ ...message, content: `[检索范围不完整]\n${message.content}` }));
    }
    const compiled = buildContextSegments({
      systemPrompt: normalizedSystemPrompt,
      coreMemoryEnabled: false,
      coreMemoryText: "",
      coreMemoryChars: 0,
      rollingSummaryEnabled: false,
      memory: null,
      memoryV2: { renderedText: contextV2.memorySegment },
      ragContext,
      gapBridge: contextV2.gapBridge,
      recent,
      timeContext: buildTimeContextState({ recentCandidates: contextV2.timeCandidates }),
    });
    return {
      messages: compiled,
      needsMemory: contextV2.needsMemory,
      segments: {
        systemPromptChars: normalizedSystemPrompt.length,
        memoryChars: Array.from(contextV2.memorySegment).length,
        rag: ragContext?.stats || null,
        gapBridge: contextV2.gapBridge.stats,
        recentWindow: { ...recent.stats, needsMemory: contextV2.needsMemory },
      },
      memory: { version: 2, sourceGeneration: contextV2.sourceGeneration, debug: contextV2.debug },
      memoryHealth: contextV2.health,
      memoryRecoveryNotifications: contextV2.notifications,
      rag: ragContext ? { enabled: Boolean(ragContext.enabled), sources: Array.isArray(ragContext.sources) ? ragContext.sources : [], stats: ragContext.stats || null } : null,
    };
  }

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

  const memorySnapshot = chatMemoryConfig.v1ContextEnabled ? await buildMemorySnapshot({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    recentWindowStartMessageId,
  }) : { memory: null, summarizedUntilMessageId: null, rollingSummaryEnabled: false, coreMemoryEnabled: false, coreMemoryText: "", coreMemoryChars: 0 };
  const memory = memorySnapshot.memory;
  const summarizedUntilMessageId = memorySnapshot.summarizedUntilMessageId;
  const rollingSummaryEnabled = memorySnapshot.rollingSummaryEnabled;
  const coreMemoryEnabled = memorySnapshot.coreMemoryEnabled;
  const coreMemoryText = memorySnapshot.coreMemoryText;
  const coreMemoryChars = memorySnapshot.coreMemoryChars;

  const gapBridge = chatMemoryConfig.v1ContextEnabled ? await buildGapBridge({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    memory,
    recentWindowStartMessageId,
    summarizedUntilMessageId,
  }) : null;

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
    beforeMessageId: summarizedUntilMessageId ?? (recentWindowStartMessageId === null ? null : Math.max(0, recentWindowStartMessageId - 1)),
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
