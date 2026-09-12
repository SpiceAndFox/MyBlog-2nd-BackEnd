const crypto = require("node:crypto");

function normalizeText(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function createChatContextCompiler({
  memoryEnabled,
  memory,
  recentWindow,
  segments,
  timeContext,
  gist,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!memory?.assembleContext) throw new Error("Chat Memory context port is required");
  if (!recentWindow?.build) throw new Error("Chat recent-window port is required");
  if (!segments?.build) throw new Error("Chat context segment builder is required");
  if (!timeContext?.build) throw new Error("Chat time-context builder is required");
  if (!gist?.scheduleBackfill) throw new Error("Chat gist backfill port is required");

  return async function compileChatContext({ userId, presetId, systemPrompt, upToMessageId } = {}) {
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
      const messages = segments.build({
        systemPrompt: normalizedSystemPrompt,
        memoryV2: { renderedText: context.memorySegment },
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
          gapBridge: context.gapBridge.stats,
          recentWindow: { ...recent.stats, needsMemory: context.needsMemory },
        },
        memory: { version: context.schemaVersion, sourceGeneration: context.sourceGeneration, debug: context.debug },
        memoryHealth: context.health,
        memoryRecoveryNotifications: context.notifications,
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

    const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
    const messages = segments.build({
      systemPrompt: normalizedSystemPrompt,
      gapBridge: null,
      recent: window.recent,
      timeContext: timeContext.build({ recentCandidates: window.recentCandidates }),
    });
    return {
      messages,
      needsMemory: window.needsMemory,
      segments: {
        systemPromptChars: normalizedSystemPrompt.length,
        gapBridge: null,
        recentWindow: {
          ...window.recent.stats,
          candidates: window.recentCandidates.length,
          selectedBeforeUserBoundary: window.selectedBeforeUserBoundary,
          needsMemory: window.needsMemory,
        },
      },
      memory: null,
    };
  };
}

module.exports = { createChatContextCompiler };
