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

function isTargetMessage(message, source) {
  const id = Number(message?.id);
  return (
    Number.isFinite(id) &&
    id >= Number(source?.firstMessageId) &&
    id <= Number(source?.lastMessageId)
  );
}

function formatConversationLine(message) {
  const role = formatRole(message?.role);
  const content = collapseWhitespace(message?.content);
  if (!content) return "";
  return `${role}: ${content}`;
}

function buildConversation(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(formatConversationLine)
    .filter(Boolean)
    .join("\n");
}

function buildPrompt({ source, messages } = {}) {
  const maxInputChars = Number(chatRagConfig.sceneRecallMaxInputChars);
  const list = Array.isArray(messages) ? messages : [];
  const targetMessages = list.filter((message) => isTargetMessage(message, source));
  const contextMessages = list.filter((message) => !isTargetMessage(message, source));

  const system = renderTemplate(normalizeTemplate(chatRagConfig.sceneRecallPrompt), {
    max_chars: chatRagConfig.sceneRecallMaxOutputChars,
  }).trim();

  const header =
    `下面是一条旧对话消息，以及它之前若干轮的对话作为参考。请只针对【消息】里那条话，` +
    `判断它当时发生的具体情景：前因后果、说话关系、情绪氛围。仅描述情景，不要复述那条话的原文，` +
    `不要泛泛概括整段对话，控制在 ${chatRagConfig.sceneRecallMaxOutputChars} 字以内。\n\n`;

  const targetLabel = "【消息】\n";
  const contextLabel = "\n\n【这条消息之前的对话（供参考，不要复述）】\n";

  const fixedOverhead = header.length + targetLabel.length + contextLabel.length;
  const reserveForTarget = Math.max(0, maxInputChars - fixedOverhead);

  const targetBlock = clipText(buildConversation(targetMessages), Math.ceil(reserveForTarget * 0.4));
  const targetSection = targetBlock ? `${targetLabel}${targetBlock}` : `${targetLabel}（无）`;

  const remainingForContext = Math.max(0, maxInputChars - header.length - targetSection.length - contextLabel.length);
  const contextBlock = clipText(buildConversation(contextMessages), remainingForContext);
  const contextSection = contextBlock ? `${contextLabel}${contextBlock}` : `${contextLabel}（无）`;

  let user = `${header}${targetSection}${contextSection}`;
  if (user.length > maxInputChars) {
    user = `${user.slice(0, Math.max(0, maxInputChars - 3)).trim()}...`;
  }

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
