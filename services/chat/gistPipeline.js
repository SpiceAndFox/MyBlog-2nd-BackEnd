const crypto = require("crypto");
const chatModel = require("@models/chatModel");
const chatMessageGistModel = require("@models/chatMessageGistModel");
const { chatContextConfig, chatGistConfig } = require("../../config");
const { logger } = require("../../logger");
const { createChatCompletion } = require("../llm/chatCompletions");
const { createSemaphore, createKeyedTaskQueue } = require("./taskQueue");
const { stripCodeFences, clipText } = require("./textUtils");

function buildKey(userId, messageId) {
  return `${String(userId || "").trim()}:${String(messageId || "").trim()}`;
}

const workerSemaphore = createSemaphore(chatGistConfig.workerConcurrency);
const { enqueue: enqueueKeyTask } = createKeyedTaskQueue();

function hashContent(content) {
  const normalized = String(content || "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function normalizeGistText(text, maxChars) {
  const cleaned = stripCodeFences(text).trim();
  if (!cleaned) return "";

  const normalized = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:[-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join("；")
    .replace(/[“”"']/g, "")
    .replace(/[。！？，；、]+/g, "；")
    .replace(/[；]+/g, "；")
    .replace(/\s+/g, " ")
    .trim();

  return clipText(normalized, maxChars).trim();
}

function buildAssistantGistPrompt({ userContent, assistantContent, maxChars }) {
  const system = `
你是「对话要点抽取器」。
请将 assistant 的回复压缩为中文要点，用于对话记忆压缩：去修辞/意象/套话，但保留「情绪/态度/关系温度」等信息（用中性标签短语表示），并保留事实/动作/意图变化。
绝对约束：
0. 只输出要点正文，不要解释，不要前后缀。
1. 禁止新增事实/设定；不确定就省略。
2. 输出为一句或多短语，用「；」分隔（不要列表/换行/emoji）。
3. 可选在开头加 0~1 个「情绪/态度」标签短语（如：温柔安抚/共情心疼/认真严肃/轻松调侃/坚定支持/中性），不要复用原文固定安慰句式。
4. 严格控制字符数不超过 ${maxChars}。
`.trim();

  const normalizedUser = String(userContent || "").trim();
  const normalizedAssistant = String(assistantContent || "").trim();
  if (!normalizedAssistant) throw new Error("Missing assistant content");

  const user = normalizedUser
    ? `
【user 原文】
${normalizedUser}

【assistant 原文】
${normalizedAssistant}
`.trim()
    : `
【assistant 原文】
${normalizedAssistant}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

async function loadAdjacentUserContent({ userId, presetId, messageId }) {
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedMessageId = Number(messageId);
  if (!userId || !normalizedPresetId || !Number.isFinite(normalizedMessageId)) return "";

  try {
    const rows = await chatModel.listRecentMessagesByPreset(userId, normalizedPresetId, {
      limit: 6,
      upToMessageId: normalizedMessageId,
    });

    if (!Array.isArray(rows) || rows.length < 2) return "";

    let assistantIndex = rows.findIndex((row) => Number(row?.id) === normalizedMessageId);
    if (assistantIndex === -1) assistantIndex = rows.length - 1;

    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (String(rows[i]?.role || "").trim() !== "user") continue;
      return String(rows[i]?.content || "").trim();
    }
  } catch (error) {
    logger.warn("chat_message_gist_load_adjacent_user_failed", {
      error,
      userId,
      presetId: normalizedPresetId,
      messageId: normalizedMessageId,
    });
  }

  return "";
}

async function generateAssistantGist({ userId, presetId, messageId, userContent, assistantContent }) {
  const providerId = chatGistConfig.workerProviderId;
  const modelId = chatGistConfig.workerModelId;
  const maxChars = chatGistConfig.maxChars;
  const workerSettings = chatGistConfig.workerSettings;
  const workerRaw = chatGistConfig.workerRaw;

  const prompt = buildAssistantGistPrompt({ userContent, assistantContent, maxChars });
  logger.debugGist("chat_message_gist_request", {
    userId,
    presetId,
    messageId,
    providerId,
    modelId,
    maxChars,
    userChars: String(userContent || "").length,
    assistantChars: String(assistantContent || "").length,
    messages: prompt.messages,
  });

  const response = await createChatCompletion({
    providerId,
    model: modelId,
    messages: prompt.messages,
    timeoutMs: chatGistConfig.workerTimeoutMs,
    settings: workerSettings,
    rawBody: workerRaw?.openaiCompatibleBody,
    rawConfig: workerRaw?.googleGenAiConfig,
  });

  const rawText = String(response?.content || "");
  const normalized = normalizeGistText(rawText, maxChars);

  logger.debugGist("chat_message_gist_response", {
    userId,
    presetId,
    messageId,
    providerId,
    modelId,
    rawText,
    normalized,
    normalizedChars: normalized.length,
  });

  return normalized;
}

async function generateAndStoreGist({ userId, presetId, messageId, content, userContent, force = false }) {
  const normalizedAssistantContent = String(content || "").trim();
  if (!normalizedAssistantContent) return;

  const contentHash = hashContent(normalizedAssistantContent);

  let existing = null;
  try {
    existing = await chatMessageGistModel.getGist(userId, presetId, messageId);
  } catch (error) {
    if (error?.code === "42P01") {
      logger.warn("chat_message_gist_table_missing", { userId, presetId });
      return;
    }
    throw error;
  }

  if (!force && existing?.contentHash && existing.contentHash === contentHash) return;

  const normalizedUserContent =
    String(userContent || "").trim() || (await loadAdjacentUserContent({ userId, presetId, messageId }));

  const startedAt = Date.now();
  const gistText = await generateAssistantGist({
    userId,
    presetId,
    messageId,
    userContent: normalizedUserContent,
    assistantContent: normalizedAssistantContent,
  });
  if (!gistText) {
    logger.warn("chat_message_gist_empty", { userId, presetId, messageId });
    return;
  }

  const result = await chatMessageGistModel.upsertGist(userId, presetId, messageId, {
    gistText,
    contentHash,
    providerId: chatGistConfig.workerProviderId,
    modelId: chatGistConfig.workerModelId,
  });

  logger.debug("chat_message_gist_updated", {
    userId,
    presetId,
    messageId,
    chars: gistText.length,
    durationMs: Date.now() - startedAt,
    providerId: chatGistConfig.workerProviderId,
    modelId: chatGistConfig.workerModelId,
    forced: Boolean(force),
    updated: Boolean(result),
  });
}

function requestAssistantGistGeneration({ userId, presetId, messageId, content, userContent, force = false } = {}) {
  if (!chatGistConfig.enabled) return;
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedMessageId = Number(messageId);
  if (!normalizedUserId || !normalizedPresetId || !Number.isFinite(normalizedMessageId)) return;

  const key = buildKey(normalizedUserId, normalizedMessageId);

  return enqueueKeyTask(key, async () => {
    const release = await workerSemaphore.acquire();
    try {
      await generateAndStoreGist({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        messageId: normalizedMessageId,
        content,
        userContent,
        force,
      });
    } catch (error) {
      logger.error("chat_message_gist_generate_failed", {
        error,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        messageId: normalizedMessageId,
        providerId: chatGistConfig.workerProviderId,
        modelId: chatGistConfig.workerModelId,
      });
    } finally {
      release();
    }
  });
}

function scheduleAssistantGistBackfill({ userId, presetId, gistBackfillCandidates } = {}) {
  if (!chatGistConfig?.enabled) return { scheduled: 0, reason: "gist_disabled" };
  if (!chatContextConfig.recentWindowAssistantGistEnabled) return { scheduled: 0, reason: "assistant_gist_disabled" };

  const candidates = Array.isArray(gistBackfillCandidates) ? gistBackfillCandidates : [];
  if (!candidates.length) return { scheduled: 0, reason: "no_candidates" };

  const workerConcurrency = Number(chatGistConfig.workerConcurrency) || 1;
  const maxPerRequest = Math.max(1, Math.min(30, Math.floor(workerConcurrency) * 5));

  let scheduled = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] || {};
    const messageId = Number(candidate.messageId);
    if (!Number.isFinite(messageId) || messageId <= 0) continue;

    const content = String(candidate.content || "").trim();
    if (!content) continue;

    requestAssistantGistGeneration({ userId, presetId, messageId, content });
    scheduled += 1;
    if (scheduled >= maxPerRequest) break;
  }

  return { scheduled, maxPerRequest, candidatesCount: candidates.length };
}

module.exports = {
  requestAssistantGistGeneration,
  scheduleAssistantGistBackfill,
};
