const { normalizeMessageId, getAssistantGistFromMap } = require("./helpers");

function createAssistantGistReader({ enabled, gistRepository, logger } = {}) {
  if (typeof gistRepository?.listGistsByMessageIds !== "function") throw new Error("Chat gist repository is required");
  if (typeof logger?.warn !== "function") throw new Error("Chat gist logger is required");

  return async function loadAssistantGistMap({ userId, presetId, candidates } = {}) {
    if (!enabled) return null;
    const list = Array.isArray(candidates) ? candidates : [];
    const assistantIds = list
      .map((row) => {
        if (String(row?.role || "").trim() !== "assistant") return null;
        const id = normalizeMessageId(row?.id);
        return id === null ? null : id;
      })
      .filter((id) => id !== null);
    if (!assistantIds.length) return null;
    try {
      const rows = await gistRepository.listGistsByMessageIds(userId, presetId, assistantIds);
      if (!rows?.length) return null;
      const map = new Map();
      for (const row of rows) {
        const messageId = normalizeMessageId(row?.messageId);
        const gistText = String(row?.gistText || "").trim();
        if (messageId === null || !gistText) continue;
        map.set(messageId, gistText);
      }
      return map;
    } catch (error) {
      if (error?.code === "42P01") {
        logger.warn("chat_message_gist_table_missing", { userId, presetId });
        return null;
      }
      throw error;
    }
  };
}

function buildAssistantGistBackfillCandidates({ assistantGistCandidates, assistantGistMap } = {}) {
  const candidates = Array.isArray(assistantGistCandidates) ? assistantGistCandidates : [];
  if (!candidates.length) return [];

  const backfill = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] || {};
    const messageId = normalizeMessageId(candidate.messageId);
    if (messageId === null) continue;

    const content = String(candidate.content || "").trim();
    if (!content) continue;

    const cachedGistBody = getAssistantGistFromMap(assistantGistMap, messageId);
    if (cachedGistBody) continue;

    backfill.push({ messageId, content });
  }

  return backfill;
}

module.exports = {
  createAssistantGistReader,
  buildAssistantGistBackfillCandidates,
};
