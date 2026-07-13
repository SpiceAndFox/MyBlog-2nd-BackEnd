const crypto = require("node:crypto");
const db = require("../../../db");
const { chatRagConfig } = require("../../../config");
const { createEmbeddings } = require("../../llm/embeddings");
const { buildTurnChunks, buildDocumentEmbeddingText } = require("./chunker");
const chatRagRepo = require("./repo");

function contentHash(content) {
  return `sha256:${crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex")}`;
}

async function listSourceMessages({ userId, presetId, boundaryMessageId }) {
  const { rows } = await db.query(`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at
    FROM chat_messages m
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE m.user_id = $1 AND m.preset_id = $2 AND s.deleted_at IS NULL
      AND m.role IN ('user','assistant') AND m.id <= $3
    ORDER BY m.id ASC
  `, [userId, presetId, boundaryMessageId]);
  return rows;
}

function buildTurns(messages, { afterMessageId = 0 } = {}) {
  const turns = [];
  let pendingUser = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    if (message.role !== "assistant" || !pendingUser) continue;
    if (String(message.session_id) !== String(pendingUser.session_id)) {
      pendingUser = null;
      continue;
    }
    if (Number(message.id) > afterMessageId) turns.push({ userMessage: pendingUser, assistantMessage: message });
    pendingUser = null;
  }
  return turns;
}

function suppressionKeys(tombstones) {
  return new Set((Array.isArray(tombstones) ? tombstones : []).map((row) =>
    `${Number(row.message_id ?? row.messageId)}\u0000${row.content_hash ?? row.contentHash}`
  ));
}

async function stageRagProjection(input, { afterMessageId = 0 } = {}) {
  if (!chatRagConfig.enabled) return { chunks: [] };
  const messages = await listSourceMessages(input);
  const suppressed = suppressionKeys(input.tombstones);
  const staged = [];
  for (const { userMessage, assistantMessage } of buildTurns(messages, { afterMessageId })) {
    const sourceRefs = [userMessage, assistantMessage].map((message) => ({
      messageId: Number(message.id),
      contentHash: contentHash(message.content),
    }));
    if (sourceRefs.some((ref) => suppressed.has(`${ref.messageId}\u0000${ref.contentHash}`))) continue;
    const metadata = {
      userMessageId: Number(userMessage.id), assistantMessageId: Number(assistantMessage.id),
      userCreatedAt: userMessage.created_at, assistantCreatedAt: assistantMessage.created_at, sourceRefs,
    };
    for (const chunk of buildTurnChunks({ userContent: userMessage.content, assistantContent: assistantMessage.content })) {
      staged.push({
        userId: input.userId, presetId: input.presetId, sessionId: Number(userMessage.session_id),
        firstMessageId: Number(userMessage.id), lastMessageId: Number(assistantMessage.id),
        chunkIndex: chunk.chunkIndex, sourceKind: "chat_turn", sourceHash: chunk.sourceHash,
        content: chunk.content, embeddingText: chunk.embeddingText, metadata,
      });
    }
  }
  const embeddings = staged.length
    ? await createEmbeddings({ texts: staged.map((chunk) => buildDocumentEmbeddingText(chunk.embeddingText)) })
    : [];
  return { chunks: staged.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })) };
}

function createChatRagProjectionAdapter() {
  return Object.freeze({
    rebuild: (input) => stageRagProjection(input),
    append: (input) => stageRagProjection(input, { afterMessageId: input.afterMessageId }),
    async commit({ mode, staged, userId, presetId, client }) {
      if (mode === "rebuild") await chatRagRepo.deleteAllChunks(userId, presetId, { client });
      for (const chunk of staged?.chunks || []) await chatRagRepo.upsertChunk(chunk, { client });
    },
  });
}

// Recall is generated at query time from the RAG hit and its raw dialogue window.
// Its checkpoint records source coverage; it has no separate derived store to commit.
function createQueryTimeRecallProjectionAdapter() {
  const stage = async ({ sourceGeneration, boundaryMessageId }) => ({ sourceGeneration, boundaryMessageId });
  return Object.freeze({ rebuild: stage, append: stage, async commit() {} });
}

module.exports = { createChatRagProjectionAdapter, createQueryTimeRecallProjectionAdapter, buildTurns };
