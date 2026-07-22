const { contentHash } = require("./sourceRefs");

function loadProjectionDependencies() {
  return {
    db: require("../../../db"),
    chatRagConfig: require("../../../config").chatRagConfig,
    createEmbeddings: require("../../../services/llm/embeddings").createEmbeddings,
    chunker: require("./chunker"),
    chatRagRepo: require("./repo"),
  };
}

async function listSourceMessages({ userId, presetId, boundaryMessageId }) {
  const { db } = loadProjectionDependencies();
  const { rows } = await db.query(`
    SELECT m.id, m.session_id, m.role, m.content, m.turn_id, m.parent_user_message_id, m.created_at
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
  const usersById = new Map();
  for (const message of messages) {
    if (message.role === "user") usersById.set(Number(message.id), message);
  }

  const pairedAssistants = new Set();
  for (const message of messages) {
    if (message.role !== "assistant" || message.parent_user_message_id === null || message.parent_user_message_id === undefined) continue;
    const userMessage = usersById.get(Number(message.parent_user_message_id));
    if (!userMessage) continue;
    if (String(message.session_id) !== String(userMessage.session_id)) continue;
    if (message.turn_id && userMessage.turn_id && String(message.turn_id) !== String(userMessage.turn_id)) continue;
    if (Number(message.id) > afterMessageId) turns.push({ userMessage, assistantMessage: message });
    pairedAssistants.add(Number(message.id));
  }

  let pendingUser = null;
  for (const message of messages) {
    if (message.role === "user") {
      if (message.turn_id) {
        pendingUser = null;
        continue;
      }
      pendingUser = message;
      continue;
    }
    if (message.role !== "assistant" || message.turn_id || pairedAssistants.has(Number(message.id)) || !pendingUser) continue;
    if (String(message.session_id) !== String(pendingUser.session_id)) {
      pendingUser = null;
      continue;
    }
    if (Number(message.id) > afterMessageId) turns.push({ userMessage: pendingUser, assistantMessage: message });
    pendingUser = null;
  }
  return turns.sort((left, right) => Number(left.assistantMessage.id) - Number(right.assistantMessage.id));
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
      const { chatRagRepo } = loadProjectionDependencies();
      if (mode === "rebuild") await chatRagRepo.deleteAllChunks(userId, presetId, { client });
      for (const chunk of staged?.chunks || []) await chatRagRepo.upsertChunk(chunk, { client });
    },
  });
}

module.exports = { createChatRagProjectionAdapter, buildTurns };
