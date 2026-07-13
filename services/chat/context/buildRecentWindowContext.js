const chatModel = require("@models/chatModel");
const { chatConfig, chatContextConfig } = require("../../../config");
const { loadAssistantGistMap, buildAssistantGistBackfillCandidates } = require("./assistantGist");
const { selectRecentWindowMessages } = require("./selectRecentWindowMessages");

async function buildRecentWindowContext({ userId, presetId, upToMessageId } = {}) {
  const maxMessages = chatConfig.recentWindowMaxMessages;
  const maxChars = chatConfig.recentWindowMaxChars;
  const candidateLimit = maxMessages + 1;

  const recentCandidates = await chatModel.listRecentMessagesByPreset(userId, presetId, {
    limit: candidateLimit,
    upToMessageId,
  });

  const assistantGistEnabled = Boolean(chatContextConfig.recentWindowAssistantGistEnabled);
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
    assistantRawLastN: chatContextConfig.recentWindowAssistantRawLastN,
    assistantGistPrefix: chatContextConfig.recentWindowAssistantGistPrefix,
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
}

module.exports = {
  buildRecentWindowContext,
};
