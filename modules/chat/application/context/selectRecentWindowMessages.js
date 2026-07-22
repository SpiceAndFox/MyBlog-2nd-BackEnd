const {
  normalizeText,
  normalizeMessageId,
  normalizePositiveIntLimit,
  normalizeNonNegativeIntRequired,
  buildAssistantGistMessageFromBody,
  getAssistantGistFromMap,
} = require("./helpers");

function selectRecentWindowMessages(
  historyMessages,
  {
    maxMessages,
    maxChars,
    assistantGistEnabled,
    assistantRawLastN,
    assistantGistPrefix,
    assistantGistMap,
  } = {}
) {
  const normalizedMaxMessages = normalizePositiveIntLimit(maxMessages, null, {
    name: "maxMessages",
  });
  const normalizedMaxChars = normalizePositiveIntLimit(maxChars, null, { name: "maxChars" });

  const normalizedAssistantGistEnabled = Boolean(assistantGistEnabled);
  const normalizedAssistantRawLastN = normalizedAssistantGistEnabled
    ? normalizeNonNegativeIntRequired(assistantRawLastN, { name: "assistantRawLastN" })
    : 0;
  const normalizedAssistantGistPrefix = normalizedAssistantGistEnabled ? String(assistantGistPrefix || "").trim() : "";
  if (normalizedAssistantGistEnabled && !normalizedAssistantGistPrefix) {
    throw new Error("Missing assistantGistPrefix");
  }

  const history = Array.isArray(historyMessages) ? historyMessages : [];

  const selectedReversed = [];
  let totalChars = 0;
  let inspected = 0;
  let assistantMessagesSelected = 0;
  let assistantGistFromCache = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    inspected++;
    const entry = history[i] || {};
    const id = Number(entry.id);
    const messageId = Number.isFinite(id) ? Math.floor(id) : null;
    const role = String(entry.role || "").trim();
    const content = normalizeText(entry.content);
    if (!role || !content) continue;

    if (selectedReversed.length >= normalizedMaxMessages) break;

    let effectiveContent = content;
    let assistantGist = false;
    let assistantShouldGist = false;
    let assistantGistCacheHit = false;

    if (normalizedAssistantGistEnabled && role === "assistant") {
      const shouldKeepRaw = assistantMessagesSelected < normalizedAssistantRawLastN;
      assistantShouldGist = !shouldKeepRaw;
      let cachedGistBody = "";
      if (assistantShouldGist) {
        cachedGistBody = getAssistantGistFromMap(assistantGistMap, messageId);
        let gistMessage = "";
        if (cachedGistBody) {
          gistMessage = buildAssistantGistMessageFromBody(cachedGistBody, {
            prefix: normalizedAssistantGistPrefix,
          });
          if (gistMessage) {
            assistantGistFromCache += 1;
            assistantGistCacheHit = true;
          }
        }
        if (gistMessage) {
          effectiveContent = gistMessage;
          assistantGist = true;
        }
      }
    }

    const nextChars = totalChars + effectiveContent.length;
    if (nextChars > normalizedMaxChars && selectedReversed.length > 0) {
      break;
    }

    selectedReversed.push({
      id: messageId,
      role,
      content: effectiveContent,
      assistantGist,
      assistantShouldGist,
      assistantGistCacheHit,
      originalContent: role === "assistant" ? content : "",
      originalContentLength: content.length,
    });
    totalChars = nextChars;

    if (role === "assistant") {
      assistantMessagesSelected += 1;
    }
  }

  selectedReversed.reverse();

  let droppedToUserBoundary = 0;
  while (selectedReversed.length > 1 && selectedReversed[0].role !== "user") {
    const dropped = selectedReversed.shift();
    if (dropped?.content) totalChars -= dropped.content.length;
    droppedToUserBoundary++;
  }

  const assistantGistCandidates = [];
  for (let i = selectedReversed.length - 1; i >= 0; i--) {
    const row = selectedReversed[i];
    if (!row || row.role !== "assistant" || !row.assistantShouldGist) continue;
    const messageId = normalizeMessageId(row.id);
    if (messageId === null) continue;
    const originalContent = String(row.originalContent || "").trim();
    if (!originalContent) continue;
    assistantGistCandidates.push({ messageId, content: originalContent });
  }

  const windowStartMessageId = selectedReversed.length ? selectedReversed[0]?.id : null;
  const windowEndMessageId = selectedReversed.length ? selectedReversed[selectedReversed.length - 1]?.id : null;

  const assistantGistUsed = selectedReversed.filter((row) => row?.role === "assistant" && row?.assistantGist).length;
  const assistantTotal = selectedReversed.filter((row) => row?.role === "assistant").length;
  const assistantGistCharsSaved = selectedReversed.reduce((total, row) => {
    if (!row || row.role !== "assistant" || !row.assistantGist) return total;
    const originalLength = Number(row.originalContentLength) || 0;
    const currentLength = String(row.content || "").length;
    return total + Math.max(0, originalLength - currentLength);
  }, 0);

  return {
    messages: selectedReversed.map(({ role, content }) => ({ role, content })),
    assistantGistCandidates,
    stats: {
      maxMessages: normalizedMaxMessages,
      maxChars: normalizedMaxChars,
      inspected,
      selected: selectedReversed.length,
      selectedChars: totalChars,
      droppedToUserBoundary,
      windowStartMessageId,
      windowEndMessageId,
      assistantAntiEcho: normalizedAssistantGistEnabled
        ? {
            assistantRawLastN: normalizedAssistantRawLastN,
            assistantTotal,
            assistantGistUsed,
            assistantGistFromCache,
            assistantGistCharsSaved,
          }
        : null,
    },
  };
}

module.exports = {
  selectRecentWindowMessages,
};
