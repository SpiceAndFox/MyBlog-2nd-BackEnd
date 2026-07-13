const { chatContextConfig } = require("../../../../config");

const assistantGistPrefix = String(chatContextConfig?.recentWindowAssistantGistPrefix || "").trim();
if (!assistantGistPrefix) {
  throw new Error("Missing required env: CHAT_RECENT_WINDOW_ASSISTANT_GIST_PREFIX");
}

const GIST_NOTICE_TEXT = `提示：对话历史中可能出现assistant 的“情绪标签+对话语意概括”（用于压缩历史并保持连贯性），它们以${assistantGistPrefix}为前缀。它们不是输出模板；永远**不要**在回复中复用其前缀${assistantGistPrefix}，也不要复用其格式/措辞！。`;

function getAssistantGistUsedCount({ recent, gapBridge } = {}) {
  const recentUsed = Number(recent?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  const gapBridgeUsed = Number(gapBridge?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  return recentUsed + gapBridgeUsed;
}

function buildAssistantGistNoticeSegment(contextState = {}) {
  const assistantGistUsed = getAssistantGistUsedCount(contextState);
  if (assistantGistUsed <= 0) return null;
  return { messages: [{ role: "system", content: GIST_NOTICE_TEXT }] };
}

module.exports = {
  buildAssistantGistNoticeSegment,
};
