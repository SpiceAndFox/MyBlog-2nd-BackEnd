const { hashGistContent, gistSourceFingerprint } = require("../../domain/gistSource");
const { buildAssistantGistMessageFromBody } = require("./helpers");

// Transform only the already-selected recent window. Raw boundaries, needsMemory,
// GapBridge, and Proposer inputs remain independent of this optional cache.
function createRecentGistRenderer({ config, contextConfig, gistRepository, gist, logger }) {
  return async function renderRecentGists({ userId, presetId, recent, sourceMessages = [], sourceHistory = sourceMessages }) {
    if (!config.enabled || !contextConfig.recentWindowAssistantGistEnabled || !sourceMessages.length) return recent;
    const keepRaw = contextConfig.recentWindowAssistantRawLastN;
    const assistantMessages = sourceMessages.filter(row => row.role === "assistant");
    const candidates = assistantMessages.slice(0, Math.max(0, assistantMessages.length - keepRaw));
    if (!candidates.length) return recent;
    let rows;
    try {
      rows = await gistRepository.listGistsByMessageIds(userId, presetId, candidates.map(row => row.id));
    } catch (error) {
      logger.warn("chat_gist_cache_read_failed", { error, userId, presetId });
      return recent;
    }
    const cached = new Map(rows.map(row => [Number(row.messageId), row]));
    const replacements = new Map();
    const missing = [];
    const rawUsers = new Map(sourceHistory.filter(row => row.role === "user").map(row => [String(row.id), row.content]));
    for (const source of candidates) {
      const row = cached.get(Number(source.id));
      const userContent = row?.userMessageId == null ? "" : rawUsers.get(String(row.userMessageId));
      const expectedHash = gistSourceFingerprint({ content: source.content, userMessageId: row?.userMessageId, userContent });
      if (!row?.gistText || row.contentHash !== hashGistContent(source.content)
        || userContent === undefined || row.sourceHash !== expectedHash) {
        missing.push({ messageId: source.id, content: source.content });
        continue;
      }
      const content = buildAssistantGistMessageFromBody(row.gistText, { prefix: contextConfig.recentWindowAssistantGistPrefix });
      if (Array.from(content).length < Array.from(source.content).length) replacements.set(Number(source.id), content);
    }
    const backfill = gist.scheduleBackfill({ userId, presetId, gistBackfillCandidates: missing });
    const messages = recent.messages.map((message, index) => {
      const source = sourceMessages[index];
      // Defensive alignment: never attach one message's gist to another message.
      if (!source || source.role !== message.role || source.content !== message.content) return message;
      const content = replacements.get(Number(source.id));
      return content ? { ...message, content } : message;
    });
    return { ...recent, messages, stats: { ...recent.stats,
      renderedChars: messages.reduce((sum, message) => sum + Array.from(message.content).length, 0),
      assistantAntiEcho: { gistUsed: replacements.size, rawLastN: keepRaw, gistBackfill: backfill },
    } };
  };
}

module.exports = { createRecentGistRenderer };
