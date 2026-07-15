const { chatRagConfig, memoryV2Config } = require("../../../config");
const { logger } = require("../../../logger");
const { createEmbeddings } = require("../../llm/embeddings");
const { rerankDocuments } = require("../../llm/reranker");
const { renderTemplate, normalizeTemplate } = require("./templates");
const { generateSceneRecallForSource } = require("./sceneRecall");
const chatRagRepo = require("./repo");
const memory = require("../../../modules/memory");
const { filterRagChunks, filterSuppressedMessages } = require("./suppression");

function parseEmbeddingVector(rawString) {
  const str = String(rawString || "").trim();
  if (!str) throw new Error("Empty embedding vector string");
  const inner = str.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) throw new Error("Empty embedding vector content");
  const parts = inner.split(",");
  return parts.map((part, index) => {
    const num = Number(part.trim());
    if (!Number.isFinite(num)) throw new Error(`Invalid embedding dimension at index ${index}: "${part}"`);
    return num;
  });
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function mmrSelect(candidates, k, lambda, scoreKey = "similarity") {
  if (!candidates.length) return [];
  if (candidates.length <= k) return [...candidates];

  const remaining = [...candidates].sort((a, b) => Number(b[scoreKey]) - Number(a[scoreKey]));
  const selected = [remaining.shift()];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      let maxSimToSelected = 0;
      for (const picked of selected) {
        const sim = cosineSimilarity(candidate.embedding, picked.embedding);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const score = lambda * Number(candidate[scoreKey]) - (1 - lambda) * maxSimToSelected;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

function normalizeQuery(value) {
  return String(value || "").trim();
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error("Request cancelled");
}

function failureKind(error) {
  if (error?.code) return String(error.code).slice(0, 80);
  if (error?.status) return `http_${error.status}`;
  return String(error?.name || "retrieval_failed").slice(0, 80);
}

function buildQueryEmbeddingText(query) {
  const rendered = renderTemplate(chatRagConfig.queryEmbeddingTemplate, { query }).trim();
  if (!rendered) throw new Error("CHAT_RAG_QUERY_EMBEDDING_TEMPLATE cannot render empty");
  return rendered;
}

function formatSimilarity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toFixed(3);
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPromptDecorations(value) {
  return collapseWhitespace(value)
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`+/g, "")
    .replace(/^#+\s*/gm, "")
    .trim();
}

function clipText(value, maxChars) {
  const normalized = stripPromptDecorations(value);
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function formatDialogueRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant") return "Assistant";
  return normalized || "Message";
}

function formatDialogueLine(message) {
  const role = formatDialogueRole(message?.role);
  const maxChars = role === "Assistant" ? chatRagConfig.recallAssistantMaxChars : chatRagConfig.recallUserMaxChars;
  const content = clipText(message?.content, maxChars);
  if (!content) return "";
  if (role === "User") return `${role}：「${content}」`;
  return `${role}：${content}`;
}

function parseHistoricalTurn(content) {
  const text = collapseWhitespace(content);
  if (!text) return { user: "", assistant: "", content: "" };

  const match = text.match(
    /(?:^|\n)(?:User|用户|用户旧消息)\s*[:：]?\s*\n([\s\S]*?)(?:\n(?:Assistant|助手|助手旧回应|助手回应)\s*[:：]?\s*\n)([\s\S]*)$/i
  );

  if (!match) return { user: "", assistant: "", content: text };

  return {
    user: match[1].trim(),
    assistant: match[2].trim(),
    content: text,
  };
}

function buildDialogueFromMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(formatDialogueLine)
    .filter(Boolean)
    .join("\n");
}

function buildDialogueFromParsedTurn(parsed) {
  const lines = [];
  const user = clipText(parsed.user, chatRagConfig.recallUserMaxChars);
  const assistant = chatRagConfig.recallIncludeAssistant
    ? clipText(parsed.assistant, chatRagConfig.recallAssistantMaxChars)
    : "";

  if (user) lines.push(`User：「${user}」`);
  if (assistant) lines.push(`Assistant：${assistant}`);
  return lines.join("\n");
}

function buildRecall(source) {
  const parsed = parseHistoricalTurn(source?.content);
  const user = clipText(parsed.user, chatRagConfig.recallUserMaxChars);
  const assistant = chatRagConfig.recallIncludeAssistant
    ? clipText(parsed.assistant, chatRagConfig.recallAssistantMaxChars)
    : "";
  const content = clipText(parsed.content, chatRagConfig.recallContentMaxChars);
  const dialogue = buildDialogueFromMessages(source?.dialogueMessages) || buildDialogueFromParsedTurn(parsed);
  const scene = clipText(source?.sceneRecall, chatRagConfig.sceneRecallMaxOutputChars);

  if (!scene && !user && !assistant && !dialogue) return content;

  const rendered = renderTemplate(chatRagConfig.recallTemplate, {
    user,
    assistant,
    content,
    dialogue,
    scene,
  }).trim();

  if (rendered) return rendered;
  return scene || dialogue || content;
}

function renderEntry(source, index) {
  return renderTemplate(chatRagConfig.contextEntryTemplate, {
    index,
    similarity: formatSimilarity(source.similarity),
    created_at: formatDate(source.createdAt),
    updated_at: formatDate(source.updatedAt),
    session_id: source.sessionId,
    first_message_id: source.firstMessageId,
    last_message_id: source.lastMessageId,
    chunk_index: source.chunkIndex,
    content: source.content,
    recall: buildRecall(source),
    scene: clipText(source?.sceneRecall, chatRagConfig.sceneRecallMaxOutputChars),
  }).trim();
}

function buildContextContent(sources) {
  const header = normalizeTemplate(chatRagConfig.contextHeader).trim();
  if (!header) throw new Error("CHAT_RAG_CONTEXT_HEADER cannot render empty");

  const maxChars = Number(chatRagConfig.maxContextChars);
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error("Invalid CHAT_RAG_MAX_CONTEXT_CHARS");

  const parts = [header];
  const usedSources = [];
  let currentLength = header.length;

  for (const source of sources) {
    const entryIndex = usedSources.length + 1;
    let entry = renderEntry(source, entryIndex);
    if (!entry) continue;

    const separatorLength = 2;
    const remaining = maxChars - currentLength - separatorLength;
    if (remaining <= 0) break;

    if (entry.length > remaining) {
      entry = entry.slice(0, remaining).trim();
    }
    if (!entry) break;

    parts.push(entry);
    usedSources.push(source);
    currentLength += separatorLength + entry.length;

    if (currentLength >= maxChars) break;
  }

  if (!usedSources.length) return { content: "", sources: [] };
  return {
    content: parts.join("\n\n").trim(),
    sources: usedSources,
  };
}

function serializeSource(source) {
  const serialized = {
    id: source.id,
    sessionId: source.sessionId,
    firstMessageId: source.firstMessageId,
    lastMessageId: source.lastMessageId,
    chunkIndex: source.chunkIndex,
    sourceKind: source.sourceKind,
    similarity: source.similarity,
    createdAt: source.createdAt,
  };

  if (source.relevanceScore !== undefined && source.relevanceScore !== null) {
    serialized.relevanceScore = source.relevanceScore;
  }

  if (chatRagConfig.debugIncludeContent) {
    serialized.content = source.content;
    if (source.sceneRecall) serialized.sceneRecall = source.sceneRecall;
  }

  return serialized;
}

async function attachDialogueMessages(sources, { userId, presetId, beforeMessageId, tombstones = [], signal } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return [];

  const beforeMessages = Number(chatRagConfig.contextBeforeMessages) || 0;
  const afterMessages = Number(chatRagConfig.contextAfterMessages) || 0;

  return Promise.all(
    list.map(async (source) => {
      throwIfAborted(signal);
      let dialogueMessages = await chatRagRepo.listMessagesAroundChunk({
        userId,
        presetId,
        sessionId: source.sessionId,
        firstMessageId: source.firstMessageId,
        lastMessageId: source.lastMessageId,
        beforeMessages,
        afterMessages,
        maxMessageId: beforeMessageId,
      });
      throwIfAborted(signal);
      dialogueMessages = filterSuppressedMessages(dialogueMessages, tombstones);
      return { ...source, dialogueMessages };
    })
  );
}

async function attachSceneRecalls(sources, { userId, presetId, beforeMessageId, tombstones = [], signal } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length || !chatRagConfig.sceneRecallEnabled) return list;

  return Promise.all(
    list.map(async (source) => {
      try {
        throwIfAborted(signal);
        const sceneRecall = await generateSceneRecallForSource({ userId, presetId, source, maxMessageId: beforeMessageId, tombstones, signal });
        return sceneRecall ? { ...source, sceneRecall } : source;
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        logger.warn("chat_rag_scene_recall_failed", {
          error,
          userId,
          presetId,
          sourceId: source.id,
          firstMessageId: source.firstMessageId,
          lastMessageId: source.lastMessageId,
        });
        return source;
      }
    })
  );
}

async function retrieveChatRagContextUnsafe({ userId, presetId, query, beforeMessageId, signal } = {}) {
  if (!chatRagConfig.enabled) {
    return { enabled: false, messages: [], sources: [], stats: { reason: "rag_disabled" } };
  }

  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery.length < chatRagConfig.minQueryChars) {
    return {
      enabled: true,
      messages: [],
      sources: [],
      stats: {
        reason: "query_too_short",
        queryChars: normalizedQuery.length,
        minQueryChars: chatRagConfig.minQueryChars,
      },
    };
  }

  const normalizedBeforeMessageId = Number(beforeMessageId);
  if (
    !Number.isFinite(normalizedBeforeMessageId) ||
    !Number.isInteger(normalizedBeforeMessageId) ||
    normalizedBeforeMessageId <= 0
  ) {
    return {
      enabled: true,
      messages: [],
      sources: [],
      stats: {
        reason: "no_retrievable_history",
      },
    };
  }

  throwIfAborted(signal);
  const [embedding] = await createEmbeddings({ texts: [buildQueryEmbeddingText(normalizedQuery)], signal });
  throwIfAborted(signal);
  const rerankerEnabled = Boolean(chatRagConfig.rerankerEnabled);
  const candidateLimit = rerankerEnabled
    ? Math.min(
        chatRagConfig.topK * chatRagConfig.rerankerCandidateMultiplier,
        chatRagConfig.rerankerMaxDocuments
      )
    : chatRagConfig.topK * chatRagConfig.mmrCandidateMultiplier;
  const rows = await chatRagRepo.searchSimilarChunks({
    userId,
    presetId,
    beforeMessageId: normalizedBeforeMessageId,
    embedding,
    limit: chatRagConfig.topK,
    minSimilarity: chatRagConfig.minSimilarity,
    candidateLimit,
  });
  throwIfAborted(signal);

  const tombstones = await memory.listSuppressionTombstones(userId, presetId);
  throwIfAborted(signal);
  const eligibleRows = filterRagChunks(rows, tombstones, { requireSourceRefs: memoryV2Config.enabled });

  if (!eligibleRows.length) {
    return {
      enabled: true,
      messages: [],
      sources: [],
      stats: {
        reason: "no_matches",
        minSimilarity: chatRagConfig.minSimilarity,
      },
    };
  }

  let selectedRows = null;
  let rerankerStats = null;

  if (rerankerEnabled) {
    rerankerStats = {
      enabled: true,
      used: false,
      fallback: false,
      model: chatRagConfig.rerankerModel,
      candidateMultiplier: chatRagConfig.rerankerCandidateMultiplier,
      maxDocuments: chatRagConfig.rerankerMaxDocuments,
      minScore: chatRagConfig.rerankerMinScore,
    };

    try {
      const rerankInput = eligibleRows.slice(0, chatRagConfig.rerankerMaxDocuments);
      const scored = await rerankDocuments({
        query: normalizedQuery,
        documents: rerankInput.map((row) => row.content),
        signal,
      });
      const scoreByIndex = new Map(scored.map((entry) => [entry.index, entry.relevanceScore]));
      const withScores = rerankInput.map((row, index) => ({
        ...row,
        relevanceScore: Number(scoreByIndex.get(index) ?? 0),
      }));

      rerankerStats.scored = scored.length;

      const filtered = withScores.filter((row) => row.relevanceScore >= chatRagConfig.rerankerMinScore);
      if (!filtered.length) {
        return {
          enabled: true,
          messages: [],
          sources: [],
          stats: {
            reason: "no_matches_after_rerank",
            matches: rows.length,
            minSimilarity: chatRagConfig.minSimilarity,
            reranker: rerankerStats,
          },
        };
      }

      filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);

      if (filtered[0].embedding) {
        const candidates = filtered.map((row) => ({
          ...row,
          embedding: parseEmbeddingVector(row.embedding),
        }));
        selectedRows = mmrSelect(candidates, chatRagConfig.topK, chatRagConfig.mmrLambda, "relevanceScore");
      } else {
        selectedRows = filtered.slice(0, chatRagConfig.topK);
      }

      rerankerStats.used = true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      logger.error("chat_rag_rerank_failed", {
        error,
        userId,
        presetId,
        queryChars: normalizedQuery.length,
        matches: rows.length,
      });
      rerankerStats.fallback = true;
    }
  }

  if (!selectedRows) {
    if (eligibleRows.length > 0 && eligibleRows[0].embedding) {
      const candidates = eligibleRows.map((row) => ({
        ...row,
        similarity: row.similarity,
        embedding: parseEmbeddingVector(row.embedding),
      }));
      selectedRows = mmrSelect(candidates, chatRagConfig.topK, chatRagConfig.mmrLambda);
    } else {
      selectedRows = eligibleRows;
    }
  }

  const withDialogue = await attachDialogueMessages(selectedRows, {
    userId,
    presetId,
    beforeMessageId: normalizedBeforeMessageId,
    tombstones,
    signal,
  });
  throwIfAborted(signal);
  const enrichedRows = await attachSceneRecalls(withDialogue, { userId, presetId, beforeMessageId: normalizedBeforeMessageId, tombstones, signal });
  throwIfAborted(signal);
  const rendered = buildContextContent(enrichedRows);
  if (!rendered.content) {
    return {
      enabled: true,
      messages: [],
      sources: [],
      stats: {
        reason: "rendered_empty",
        matches: rows.length,
      },
    };
  }

  return {
    enabled: true,
    messages: [{ role: "system", content: rendered.content }],
    sources: rendered.sources.map(serializeSource),
    stats: {
      reason: "matches",
      matches: rows.length,
      used: rendered.sources.length,
      minSimilarity: chatRagConfig.minSimilarity,
      maxContextChars: chatRagConfig.maxContextChars,
      sceneRecall: {
        enabled: Boolean(chatRagConfig.sceneRecallEnabled),
        contextTurns: chatRagConfig.sceneRecallContextTurns,
        providerId: chatRagConfig.sceneRecallProviderId,
        modelId: chatRagConfig.sceneRecallModelId,
      },
      mmr: { lambda: chatRagConfig.mmrLambda, candidateLimit },
      ...(rerankerStats ? { reranker: rerankerStats } : {}),
    },
  };
}

async function retrieveChatRagContext(options = {}) {
  if (!chatRagConfig.enabled) return retrieveChatRagContextUnsafe(options);
  const parentSignal = options.signal;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error("Request cancelled"));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    const error = Object.assign(new Error("RAG query deadline exceeded"), { code: "RAG_QUERY_TIMEOUT" });
    controller.abort(error);
  }, chatRagConfig.queryTimeoutMs);

  try {
    const aborted = new Promise((_, reject) => {
      const rejectFromAbort = () => reject(controller.signal.reason || new Error("RAG query cancelled"));
      if (controller.signal.aborted) rejectFromAbort();
      else controller.signal.addEventListener("abort", rejectFromAbort, { once: true });
    });
    return await Promise.race([
      retrieveChatRagContextUnsafe({ ...options, signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason || error;
    const failure = failureKind(error);
    logger.warn("chat_rag_query_degraded", {
      error,
      userId: options.userId,
      presetId: options.presetId,
      failure,
    });
    return {
      enabled: true,
      messages: [],
      sources: [],
      stats: { reason: "retrieval_degraded", degraded: true, failure },
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

module.exports = {
  retrieveChatRagContext,
  parseEmbeddingVector,
  mmrSelect,
};
