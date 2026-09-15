const { createGistWorker } = require("./gistWorker");
const defaultText = require("./textUtils");

function createChatGistService({ config, contextConfig, gistRepository, llm, text = defaultText, logger } = {}) {
  if (!config || !contextConfig) throw new Error("Chat gist config is required");
  if (!Number.isSafeInteger(config.backfillMaxPerRequest) || config.backfillMaxPerRequest <= 0)
    throw new Error("Gist config.backfillMaxPerRequest must be a positive safe integer");
  for (const method of ["enqueueGistTask", "claimGistTask", "finishGistTask", "getGistSource", "getGistTask"]) {
    if (typeof gistRepository?.[method] !== "function") throw new Error(`Chat gist repository requires ${method}`);
  }
  if (typeof llm?.complete !== "function") throw new Error("Chat gist LLM port is required");
  if (!text?.stripCodeFences || !text?.clipText) throw new Error("Chat gist text utilities are required");
  if (!logger?.debug || !logger?.warn || !logger?.error) throw new Error("Chat gist logger is required");

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
3. 严格控制字符数不超过 ${config.maxChars}。
`.trim();
    const normalizedUser = String(userContent || "").trim();
    const user = normalizedUser
      ? `【user 原文】\n${normalizedUser}\n\n【assistant 原文】\n${normalizedAssistant}`
      : `【assistant 原文】\n${normalizedAssistant}`;
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  async function generate({ content, userContent, signal }) {
    const response = await llm.complete({
      providerId: config.workerProviderId,
      model: config.workerModelId,
      messages: buildPrompt({ userContent, assistantContent: content }),
      timeoutMs: config.workerTimeoutMs,
      signal,
      settings: config.workerSettings,
      rawBody: config.workerRaw?.openaiCompatibleBody,
      rawConfig: config.workerRaw?.googleGenAiConfig,
    });
    const gistText = normalizeGistText(response?.content);
    if (!gistText) throw new Error("Empty gist response");
    return { gistText, providerId: config.workerProviderId, modelId: config.workerModelId };
  }

  const worker = createGistWorker({ config, repository: gistRepository, generate, logger });
  const { requestGeneration } = worker;

  function scheduleBackfill({ userId, presetId, gistBackfillCandidates } = {}) {
    if (!config.enabled) return { scheduled: 0, reason: "gist_disabled" };
    if (!contextConfig.recentWindowAssistantGistEnabled) return { scheduled: 0, reason: "assistant_gist_disabled" };
    const candidates = Array.isArray(gistBackfillCandidates) ? gistBackfillCandidates : [];
    if (!candidates.length) return { scheduled: 0, reason: "no_candidates" };
    const maxPerRequest = config.backfillMaxPerRequest;
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

  return Object.freeze({ ...worker, scheduleBackfill });
}

module.exports = { createChatGistService };
