const crypto = require("node:crypto");

function normalizeText(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function normalizeMessageId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readCurrentUserContent({ recent } = {}) {
  const messages = Array.isArray(recent?.messages) ? recent.messages : [];
  const last = messages.at(-1);
  return last?.role === "user" ? normalizeText(last.content).trim() : "";
}

function createChatContextCompiler({
  memoryEnabled,
  memory,
  rag,
  recentWindow,
  segments,
  timeContext,
  gist,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!memory?.assembleContext) throw new Error("Chat Memory context port is required");
  if (!rag?.retrieve) throw new Error("Chat RAG retrieval port is required");
  if (!recentWindow?.build) throw new Error("Chat recent-window port is required");
  if (!segments?.build) throw new Error("Chat context segment builder is required");
  if (!timeContext?.build) throw new Error("Chat time-context builder is required");
  if (!gist?.scheduleBackfill) throw new Error("Chat gist backfill port is required");

  return async function compileChatContext({ userId, presetId, systemPrompt, upToMessageId, signal } = {}) {
    const normalizedPresetId = String(presetId || "").trim();
    if (!userId) throw new Error("Missing userId");
    if (!normalizedPresetId) throw new Error("Missing presetId");

    if (memoryEnabled) {
      const context = await memory.assembleContext({
        userId,
        presetId: normalizedPresetId,
        upToMessageId,
        requestId: randomUUID(),
      });
      const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
      const recent = context.recent;
      const requiredBoundary = Math.max(0, Number(recent.stats.windowStartMessageId || 1) - 1);
      const projection = context.projectionCoverage.find((entry) => entry.projectionKey === "rag");
      const ragBoundary = projection ? Math.min(requiredBoundary, projection.processedBoundary) : requiredBoundary;
      const ragContext = !projection || projection.queryHealth === "rebuilding"
        ? {
            enabled: true,
            messages: [],
            sources: [],
            stats: { reason: projection ? "projection_rebuilding" : "projection_checkpoint_missing" },
          }
        : await rag.retrieve({
            userId,
            presetId: normalizedPresetId,
            query: readCurrentUserContent({ recent }),
            beforeMessageId: ragBoundary,
            signal,
          });
      if (projection && projection.queryHealth !== "healthy" && ragContext?.messages?.length) {
        ragContext.messages = ragContext.messages.map((message) => ({
          ...message,
          content: `[检索范围不完整]\n${message.content}`,
        }));
      }
      const messages = segments.build({
        systemPrompt: normalizedSystemPrompt,
        memoryV2: { renderedText: context.memorySegment },
        ragContext,
        gapBridge: context.gapBridge,
        recent,
        timeContext: timeContext.build({ recentCandidates: context.timeCandidates }),
      });
      return {
        messages,
        needsMemory: context.needsMemory,
        segments: {
          systemPromptChars: normalizedSystemPrompt.length,
          memoryChars: Array.from(context.memorySegment).length,
          rag: ragContext?.stats || null,
          gapBridge: context.gapBridge.stats,
          recentWindow: { ...recent.stats, needsMemory: context.needsMemory },
        },
        memory: { version: context.schemaVersion, sourceGeneration: context.sourceGeneration, debug: context.debug },
        memoryHealth: context.health,
        memoryRecoveryNotifications: context.notifications,
        rag: ragContext ? {
          enabled: Boolean(ragContext.enabled),
          sources: Array.isArray(ragContext.sources) ? ragContext.sources : [],
          stats: ragContext.stats || null,
        } : null,
      };
    }

    const window = await recentWindow.build({ userId, presetId: normalizedPresetId, upToMessageId });
    const recentGistBackfill = gist.scheduleBackfill({
      userId,
      presetId: normalizedPresetId,
      gistBackfillCandidates: window.gistBackfillCandidates,
    });
    if (window.recent?.stats?.assistantAntiEcho) {
      window.recent.stats.assistantAntiEcho.gistBackfill = recentGistBackfill;
    }

    const recentWindowStartMessageId = normalizeMessageId(window.recent.stats.windowStartMessageId);
    const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
    const ragContext = await rag.retrieve({
      userId,
      presetId: normalizedPresetId,
      query: readCurrentUserContent({ recent: window.recent }),
      beforeMessageId: recentWindowStartMessageId === null ? null : Math.max(0, recentWindowStartMessageId - 1),
      signal,
    });
    const messages = segments.build({
      systemPrompt: normalizedSystemPrompt,
      ragContext,
      gapBridge: null,
      recent: window.recent,
      timeContext: timeContext.build({ recentCandidates: window.recentCandidates }),
    });
    return {
      messages,
      needsMemory: window.needsMemory,
      segments: {
        systemPromptChars: normalizedSystemPrompt.length,
        rag: ragContext?.stats || null,
        gapBridge: null,
        recentWindow: {
          ...window.recent.stats,
          candidates: window.recentCandidates.length,
          selectedBeforeUserBoundary: window.selectedBeforeUserBoundary,
          needsMemory: window.needsMemory,
        },
      },
      memory: null,
      rag: ragContext ? {
        enabled: Boolean(ragContext.enabled),
        sources: Array.isArray(ragContext.sources) ? ragContext.sources : [],
        stats: ragContext.stats || null,
      } : null,
    };
  };
}

module.exports = { createChatContextCompiler };
