const { chatRagConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { createEmbeddings } = require("../../llm/embeddings");
const { buildTurnChunks, buildDocumentEmbeddingText } = require("./chunker");
const chatRagRepo = require("./repo");
const crypto = require("node:crypto");
const memory = require("../../../modules/memory");

function normalizePositiveInteger(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${name || "id"}: ${String(value)}`);
  }
  return number;
}

function normalizePresetId(presetId) {
  const normalized = String(presetId || "").trim();
  if (!normalized) throw new Error("Preset id is required");
  return normalized;
}

function buildTurnMetadata({ userMessage, assistantMessage } = {}) {
  const sourceRefs = [
    { messageId: Number(userMessage?.id), contentHash: `sha256:${crypto.createHash("sha256").update(String(userMessage?.content ?? userMessage?.contentText ?? ""), "utf8").digest("hex")}` },
    { messageId: Number(assistantMessage?.id), contentHash: `sha256:${crypto.createHash("sha256").update(String(assistantMessage?.content ?? assistantMessage?.contentText ?? ""), "utf8").digest("hex")}` },
  ];
  return {
    userMessageId: userMessage?.id || null,
    assistantMessageId: assistantMessage?.id || null,
    userCreatedAt: userMessage?.created_at || userMessage?.createdAt || null,
    assistantCreatedAt: assistantMessage?.created_at || assistantMessage?.createdAt || null,
    sourceRefs,
  };
}

async function indexChatTurn({
  userId,
  presetId,
  sessionId,
  userMessage,
  assistantMessage,
  userContent,
  assistantContent,
} = {}) {
  if (!chatRagConfig.enabled) return { indexed: 0, reason: "rag_disabled" };

  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedSessionId = normalizePositiveInteger(sessionId, { name: "sessionId" });
  const firstMessageId = normalizePositiveInteger(userMessage?.id, { name: "userMessage.id" });
  const lastMessageId = normalizePositiveInteger(assistantMessage?.id, { name: "assistantMessage.id" });

  if (firstMessageId > lastMessageId) throw new Error("Invalid chat turn message range for RAG indexing");

  const tombstones = await memory.listSuppressionTombstones(normalizedUserId, normalizedPresetId, { messageIds: [firstMessageId, lastMessageId] });
  const prepared = await prepareChatTurnProjection({
    userId: normalizedUserId, presetId: normalizedPresetId, sessionId: normalizedSessionId,
    userMessage, assistantMessage, userContent, assistantContent, tombstones,
  });
  if (prepared.reason) return { indexed: 0, reason: prepared.reason };

  let indexed = 0;
  for (const chunk of prepared.chunks) {
    await chatRagRepo.upsertChunk(chunk);
    indexed += 1;
  }

  return { indexed };
}

async function prepareChatTurnProjection({ userId, presetId, sessionId, userMessage, assistantMessage, userContent, assistantContent, tombstones = [] } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedSessionId = normalizePositiveInteger(sessionId, { name: "sessionId" });
  const firstMessageId = normalizePositiveInteger(userMessage?.id, { name: "userMessage.id" });
  const lastMessageId = normalizePositiveInteger(assistantMessage?.id, { name: "assistantMessage.id" });
  if (firstMessageId > lastMessageId) throw new Error("Invalid chat turn message range for RAG indexing");
  const chunks = buildTurnChunks({ userContent, assistantContent });
  if (!chunks.length) return { chunks: [], reason: "empty_chunks" };
  const metadata = buildTurnMetadata({ userMessage: { ...userMessage, content: userContent }, assistantMessage: { ...assistantMessage, content: assistantContent } });
  const suppressed = new Set(tombstones.map((row) => `${Number(row.message_id ?? row.messageId)}\u0000${row.content_hash ?? row.contentHash}`));
  if (metadata.sourceRefs.some((ref) => suppressed.has(`${ref.messageId}\u0000${ref.contentHash}`))) {
    return { chunks: [], reason: "source_suppressed" };
  }
  const embeddings = await createEmbeddings({ texts: chunks.map((chunk) => buildDocumentEmbeddingText(chunk.embeddingText)) });
  return {
    chunks: chunks.map((chunk, index) => ({
      userId: normalizedUserId, presetId: normalizedPresetId, sessionId: normalizedSessionId,
      firstMessageId, lastMessageId, chunkIndex: chunk.chunkIndex, sourceKind: "chat_turn",
      sourceHash: chunk.sourceHash, content: chunk.content, embeddingText: chunk.embeddingText,
      metadata, embedding: embeddings[index],
    })),
  };
}

function requestChatTurnIndexing(options = {}) {
  if (!chatRagConfig.enabled) return { scheduled: false, reason: "rag_disabled" };

  void indexChatTurn(options).catch((error) => {
    logger.error("chat_rag_turn_index_failed", {
      error,
      userId: options?.userId,
      presetId: options?.presetId,
      sessionId: options?.sessionId,
      userMessageId: options?.userMessage?.id,
      assistantMessageId: options?.assistantMessage?.id,
    });
  });

  return { scheduled: true };
}

async function deleteChunksFromMessageId({ userId, presetId, fromMessageId } = {}) {
  if (!chatRagConfig.enabled) return { deleted: 0, reason: "rag_disabled" };
  const deleted = await chatRagRepo.deleteChunksFromMessageId(userId, presetId, fromMessageId);
  return { deleted };
}

function requestDeleteChunksFromMessageId(options = {}) {
  if (!chatRagConfig.enabled) return { scheduled: false, reason: "rag_disabled" };

  void deleteChunksFromMessageId(options).catch((error) => {
    logger.error("chat_rag_delete_from_message_failed", {
      error,
      userId: options?.userId,
      presetId: options?.presetId,
      fromMessageId: options?.fromMessageId,
    });
  });

  return { scheduled: true };
}

module.exports = {
  indexChatTurn,
  prepareChatTurnProjection,
  requestChatTurnIndexing,
  deleteChunksFromMessageId,
  requestDeleteChunksFromMessageId,
};
