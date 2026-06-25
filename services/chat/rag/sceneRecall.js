const { chatRagConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { createChatCompletion } = require("../../llm/chatCompletions");
const { renderTemplate, normalizeTemplate } = require("./templates");
const chatRagRepo = require("./repo");

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCodeFences(value) {
  const text = String(value || "").trim();
  return text
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function clipText(value, maxChars) {
  const normalized = collapseWhitespace(value);
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function formatRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant") return "Assistant";
  return normalized || "Message";
}

function isHitMessage(message, source) {
  const id = Number(message?.id);
  return (
    Number.isFinite(id) &&
    id >= Number(source?.firstMessageId) &&
    id <= Number(source?.lastMessageId)
  );
}

function formatTranscriptLine(message, source) {
  const role = formatRole(message?.role);
  const marker = isHitMessage(message, source) ? "（命中回合）" : "";
  const content = collapseWhitespace(message?.content);
  if (!content) return "";
  return `${role}${marker}: ${content}`;
}

function buildTranscript(messages, source) {
  const lines = (Array.isArray(messages) ? messages : [])
    .map((message) => formatTranscriptLine(message, source))
    .filter(Boolean);
  return lines.join("\n");
}

function buildPrompt({ source, messages } = {}) {
  const transcript = clipText(buildTranscript(messages, source), chatRagConfig.sceneRecallMaxInputChars);
  const system = renderTemplate(normalizeTemplate(chatRagConfig.sceneRecallPrompt), {
    max_chars: chatRagConfig.sceneRecallMaxOutputChars,
  }).trim();

  const user = `
下面是一段旧对话窗口，其中“命中回合”是本次 RAG 检索命中的那轮对话。
请只基于这段旧对话，概括命中回合当时的情景、前因后果、说话关系和情绪氛围。

【旧对话窗口】
${transcript}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

function normalizeSceneRecall(rawText) {
  const cleaned = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:[-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return clipText(cleaned, chatRagConfig.sceneRecallMaxOutputChars);
}

async function generateSceneRecallForSource({ userId, presetId, source } = {}) {
  if (!chatRagConfig.sceneRecallEnabled) return "";

  const contextTurns = Number(chatRagConfig.sceneRecallContextTurns) || 0;
  const beforeMessages = contextTurns * 2;
  const messages = await chatRagRepo.listMessagesAroundChunk({
    userId,
    presetId,
    sessionId: source.sessionId,
    firstMessageId: source.firstMessageId,
    lastMessageId: source.lastMessageId,
    beforeMessages,
    afterMessages: 0,
  });

  if (!messages.length) return "";

  const prompt = buildPrompt({ source, messages });
  logger.debug("chat_rag_scene_recall_request", {
    userId,
    presetId,
    sourceId: source.id,
    firstMessageId: source.firstMessageId,
    lastMessageId: source.lastMessageId,
    contextTurns,
    providerId: chatRagConfig.sceneRecallProviderId,
    modelId: chatRagConfig.sceneRecallModelId,
    messages: prompt.messages,
  });

  const response = await createChatCompletion({
    providerId: chatRagConfig.sceneRecallProviderId,
    model: chatRagConfig.sceneRecallModelId,
    messages: prompt.messages,
    timeoutMs: chatRagConfig.sceneRecallTimeoutMs,
    settings: chatRagConfig.sceneRecallWorkerSettings,
    rawBody: chatRagConfig.sceneRecallRaw?.openaiCompatibleBody,
    rawConfig: chatRagConfig.sceneRecallRaw?.googleGenAiConfig,
  });

  const normalized = normalizeSceneRecall(response?.content);
  logger.debug("chat_rag_scene_recall_response", {
    userId,
    presetId,
    sourceId: source.id,
    firstMessageId: source.firstMessageId,
    lastMessageId: source.lastMessageId,
    chars: normalized.length,
    content: normalized,
  });

  return normalized;
}

module.exports = {
  generateSceneRecallForSource,
  buildPrompt,
  normalizeSceneRecall,
};
