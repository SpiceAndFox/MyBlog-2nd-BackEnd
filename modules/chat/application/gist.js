const crypto = require("node:crypto");
const defaultTaskQueue = require("./taskQueue");
const defaultText = require("./textUtils");

function createChatGistService({
  config,
  contextConfig,
  chatRepository,
  gistRepository,
  llm,
  taskQueue = defaultTaskQueue,
  text = defaultText,
  logger,
} = {}) {
  if (!config || !contextConfig) throw new Error("Chat gist config is required");
  if (typeof chatRepository?.listRecentMessagesByPreset !== "function") throw new Error("Chat repository is required");
  if (!gistRepository?.getGist || !gistRepository?.upsertGist) throw new Error("Chat gist repository is required");
  if (typeof llm?.complete !== "function") throw new Error("Chat gist LLM port is required");
  if (!taskQueue?.createSemaphore || !taskQueue?.createKeyedTaskQueue) throw new Error("Chat gist task queue is required");
  if (!text?.stripCodeFences || !text?.clipText) throw new Error("Chat gist text utilities are required");
  if (!logger?.debug || !logger?.warn || !logger?.error) throw new Error("Chat gist logger is required");

  const workerSemaphore = taskQueue.createSemaphore(config.workerConcurrency);
  const { enqueue } = taskQueue.createKeyedTaskQueue();

  function hashContent(content) {
    return crypto.createHash("sha256").update(String(content || "")).digest("hex");
  }

  function normalizeGistText(value) {
    const cleaned = text.stripCodeFences(value).trim();
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
    return text.clipText(normalized, config.maxChars).trim();
  }

  function buildPrompt({ userContent, assistantContent }) {
    const normalizedAssistant = String(assistantContent || "").trim();
    if (!normalizedAssistant) throw new Error("Missing assistant content");
    const system = `
你是「对话要点抽取器」。
请将 assistant 的回复压缩为中文要点，用于对话记忆压缩：去修辞/意象/套话，但保留「情绪/态度/关系温度」等信息（用中性标签短语表示），并保留事实/动作/意图变化。
绝对约束：
0. 只输出要点正文，不要解释，不要前后缀。
1. 禁止新增事实/设定；不确定就省略。
2. 输出为一句或多短语，用「；」分隔（不要列表/换行/emoji）。
3. 可选在开头加 0~1 个「情绪/态度」标签短语（如：温柔安抚/共情心疼/认真严肃/轻松调侃/坚定支持/中性），不要复用原文固定安慰句式。
4. 严格控制字符数不超过 ${config.maxChars}。
`.trim();
    const normalizedUser = String(userContent || "").trim();
    const user = normalizedUser
      ? `【user 原文】\n${normalizedUser}\n\n【assistant 原文】\n${normalizedAssistant}`
      : `【assistant 原文】\n${normalizedAssistant}`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  async function loadAdjacentUserContent({ userId, presetId, messageId }) {
    try {
      const rows = await chatRepository.listRecentMessagesByPreset(userId, presetId, {
        limit: 6,
        upToMessageId: messageId,
      });
      if (!Array.isArray(rows) || rows.length < 2) return "";
      let assistantIndex = rows.findIndex((row) => Number(row?.id) === Number(messageId));
      if (assistantIndex === -1) assistantIndex = rows.length - 1;
      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        if (String(rows[index]?.role || "").trim() === "user") return String(rows[index]?.content || "").trim();
      }
    } catch (error) {
      logger.warn("chat_message_gist_load_adjacent_user_failed", { error, userId, presetId, messageId });
    }
    return "";
  }

  async function generateAndStore({ userId, presetId, messageId, content, userContent, force = false }) {
    const assistantContent = String(content || "").trim();
    if (!assistantContent) return;
    const contentHash = hashContent(assistantContent);
    let existing;
    try {
      existing = await gistRepository.getGist(userId, presetId, messageId);
    } catch (error) {
      if (error?.code === "42P01") {
        logger.warn("chat_message_gist_table_missing", { userId, presetId });
        return;
      }
      throw error;
    }
    if (!force && existing?.contentHash === contentHash) return;
    const resolvedUserContent = String(userContent || "").trim()
      || await loadAdjacentUserContent({ userId, presetId, messageId });
    const startedAt = Date.now();
    const response = await llm.complete({
      providerId: config.workerProviderId,
      model: config.workerModelId,
      messages: buildPrompt({ userContent: resolvedUserContent, assistantContent }),
      timeoutMs: config.workerTimeoutMs,
      settings: config.workerSettings,
      rawBody: config.workerRaw?.openaiCompatibleBody,
      rawConfig: config.workerRaw?.googleGenAiConfig,
    });
    const gistText = normalizeGistText(response?.content);
    if (!gistText) {
      logger.warn("chat_message_gist_empty", { userId, presetId, messageId });
      return;
    }
    const result = await gistRepository.upsertGist(userId, presetId, messageId, {
      gistText,
      contentHash,
      providerId: config.workerProviderId,
      modelId: config.workerModelId,
    });
    logger.debug("chat_message_gist_updated", {
      userId,
      presetId,
      messageId,
      chars: gistText.length,
      durationMs: Date.now() - startedAt,
      providerId: config.workerProviderId,
      modelId: config.workerModelId,
      forced: Boolean(force),
      updated: Boolean(result),
    });
  }

  function requestGeneration({ userId, presetId, messageId, content, userContent, force = false } = {}) {
    const normalizedPresetId = String(presetId || "").trim();
    const normalizedMessageId = Number(messageId);
    if (!config.enabled || !userId || !normalizedPresetId || !Number.isFinite(normalizedMessageId)) return;
    return enqueue(`${String(userId).trim()}:${normalizedMessageId}`, async () => {
      const release = await workerSemaphore.acquire();
      try {
        await generateAndStore({
          userId,
          presetId: normalizedPresetId,
          messageId: normalizedMessageId,
          content,
          userContent,
          force,
        });
      } catch (error) {
        logger.error("chat_message_gist_generate_failed", {
          error,
          userId,
          presetId: normalizedPresetId,
          messageId: normalizedMessageId,
          providerId: config.workerProviderId,
          modelId: config.workerModelId,
        });
      } finally {
        release();
      }
    });
  }

  function scheduleBackfill({ userId, presetId, gistBackfillCandidates } = {}) {
    if (!config.enabled) return { scheduled: 0, reason: "gist_disabled" };
    if (!contextConfig.recentWindowAssistantGistEnabled) return { scheduled: 0, reason: "assistant_gist_disabled" };
    const candidates = Array.isArray(gistBackfillCandidates) ? gistBackfillCandidates : [];
    if (!candidates.length) return { scheduled: 0, reason: "no_candidates" };
    const maxPerRequest = Math.max(1, Math.min(30, (Number(config.workerConcurrency) || 1) * 5));
    let scheduled = 0;
    for (const candidate of candidates) {
      const candidateMessageId = Number(candidate?.messageId);
      const candidateContent = String(candidate?.content || "").trim();
      if (!Number.isFinite(candidateMessageId) || candidateMessageId <= 0 || !candidateContent) continue;
      requestGeneration({ userId, presetId, messageId: candidateMessageId, content: candidateContent });
      scheduled += 1;
      if (scheduled >= maxPerRequest) break;
    }
    return { scheduled, maxPerRequest, candidatesCount: candidates.length };
  }

  return Object.freeze({ requestGeneration, scheduleBackfill });
}

module.exports = { createChatGistService };
