const { createAssistantGistReader, buildAssistantGistBackfillCandidates } = require("./assistantGist");
const { selectRecentWindowMessages } = require("./selectRecentWindowMessages");

function createRecentWindowContextBuilder({ config, contextConfig, gistConfig, chatRepository, gistRepository, logger } = {}) {
  if (!config || !contextConfig || !gistConfig) throw new Error("Chat recent-window config is required");
  if (typeof chatRepository?.listRecentMessagesByPreset !== "function") throw new Error("Chat repository is required");
  const loadAssistantGistMap = createAssistantGistReader({ enabled: gistConfig.enabled, gistRepository, logger });

  return async function buildRecentWindowContext({ userId, presetId, upToMessageId } = {}) {
    const maxMessages = config.recentWindowMaxMessages;
    const maxChars = config.recentWindowMaxChars;
    const candidateLimit = maxMessages + 1;

    const recentCandidates = await chatRepository.listRecentMessagesByPreset(userId, presetId, {
      limit: candidateLimit,
      upToMessageId,
    });

    const assistantGistEnabled = Boolean(contextConfig.recentWindowAssistantGistEnabled);
    const assistantGistMap = assistantGistEnabled
      ? await loadAssistantGistMap({
        userId,
        presetId,
        candidates: recentCandidates,
      })
      : null;

    const recent = selectRecentWindowMessages(recentCandidates, {
      maxMessages,
      maxChars,
      assistantGistEnabled,
      assistantRawLastN: contextConfig.recentWindowAssistantRawLastN,
      assistantGistPrefix: contextConfig.recentWindowAssistantGistPrefix,
      assistantGistMap,
    });

  const gistBackfillCandidates = buildAssistantGistBackfillCandidates({
    assistantGistCandidates: recent.assistantGistCandidates,
    assistantGistMap,
  });

  const selectedBeforeUserBoundary = recent.stats.selected + recent.stats.droppedToUserBoundary;
  const reachedCandidateLimit = recentCandidates.length === candidateLimit;
  const needsMemory = reachedCandidateLimit || recentCandidates.length > selectedBeforeUserBoundary;

    return {
      recent,
      recentCandidates,
      selectedBeforeUserBoundary,
      needsMemory,
      gistBackfillCandidates,
    };
  };
}

module.exports = {
  createRecentWindowContextBuilder,
};
