const { contentHash, sourceRefsAreSuppressed } = require("./suppression");

function loadProjectionDependencies() {
  return {
    db: require("../../../db"),
    chatRagConfig: require("../../../config").chatRagConfig,
    createEmbeddings: require("../../llm/embeddings").createEmbeddings,
    chunker: require("./chunker"),
    chatRagRepo: require("./repo"),
  };
}

async function listSourceMessages({ userId, presetId, boundaryMessageId }) {
  const { db } = loadProjectionDependencies();
  const { rows } = await db.query(`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at
    FROM chat_messages m
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE m.user_id = $1 AND m.preset_id = $2 AND s.user_id = m.user_id AND s.deleted_at IS NULL
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

async function stageRagProjection(input, { afterMessageId = 0 } = {}) {
  const { chatRagConfig, createEmbeddings, chunker } = loadProjectionDependencies();
  const { buildTurnChunks, buildDocumentEmbeddingText } = chunker;
  if (!chatRagConfig.enabled) return { chunks: [] };
  const messages = await listSourceMessages(input);
  const staged = [];
  for (const { userMessage, assistantMessage } of buildTurns(messages, { afterMessageId })) {
    const sourceRefs = [userMessage, assistantMessage].map((message) => ({
      messageId: Number(message.id),
      contentHash: contentHash(message.content),
    }));
    if (sourceRefsAreSuppressed(sourceRefs, input.tombstones)) continue;
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
    suppress: ({ userId, presetId, tombstones, client }) => loadProjectionDependencies().chatRagRepo.deleteSuppressedChunks(userId, presetId, tombstones, { client }),
    async commit({ mode, staged, userId, presetId, client }) {
      const { chatRagRepo } = loadProjectionDependencies();
      if (mode === "rebuild") await chatRagRepo.deleteAllChunks(userId, presetId, { client });
      for (const chunk of staged?.chunks || []) await chatRagRepo.upsertChunk(chunk, { client });
    },
  });
}

module.exports = { createChatRagProjectionAdapter, buildTurns };
