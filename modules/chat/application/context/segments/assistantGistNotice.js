function getAssistantGistUsedCount({ recent, gapBridge } = {}) {
  const recentUsed = Number(recent?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  const gapBridgeUsed = Number(gapBridge?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  return recentUsed + gapBridgeUsed;
}

function createAssistantGistNoticeSegment({ assistantGistPrefix } = {}) {
  const prefix = String(assistantGistPrefix || "").trim();
  if (!prefix) throw new Error("Chat assistant gist prefix is required");
  const notice = `提示：对话历史中可能出现assistant 的“情绪标签+对话语意概括”（用于压缩历史并保持连贯性），它们以${prefix}为前缀。它们不是输出模板；永远**不要**在回复中复用其前缀${prefix}，也不要复用其格式/措辞！。`;
  return function buildAssistantGistNoticeSegment(contextState = {}) {
    if (getAssistantGistUsedCount(contextState) <= 0) return null;
    return { messages: [{ role: "system", content: notice }] };
  };
}

module.exports = { createAssistantGistNoticeSegment };
