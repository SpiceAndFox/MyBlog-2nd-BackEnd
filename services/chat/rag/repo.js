const db = require("../../../db");
const { chatRagConfig } = require("../../../config");

function normalizePresetId(presetId) {
  const normalized = String(presetId || "").trim();
  if (!normalized) throw new Error("Preset id is required");
  return normalized;
}

function normalizePositiveInteger(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${name || "id"}: ${String(value)}`);
  }
  return number;
}

function normalizeNonNegativeInteger(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid ${name || "value"}: ${String(value)}`);
  }
  return number;
}

function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) throw new Error("Embedding must be an array");
  if (embedding.length !== chatRagConfig.embeddingDimensions) {
    throw new Error(`Embedding dimensions mismatch: expected ${chatRagConfig.embeddingDimensions}, got ${embedding.length}`);
  }
  return embedding.map((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid embedding dimension ${index}`);
    return number;
  });
}

function toVectorLiteral(embedding) {
  const normalized = normalizeEmbedding(embedding);
  return `[${normalized.join(",")}]`;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata;
}

function mapMessageRow(row) {
  return {
    id: Number(row.id),
    role: String(row.role || "").trim(),
    content: String(row.content || "").trim(),
    createdAt: row.created_at,
  };
}

async function upsertChunk({
  userId,
  presetId,
  sessionId,
  firstMessageId,
  lastMessageId,
  chunkIndex,
  sourceKind,
  sourceHash,
  content,
  embeddingText,
  metadata,
  embedding,
} = {}, { client } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedSessionId = normalizePositiveInteger(sessionId, { name: "sessionId" });
  const normalizedFirstMessageId = normalizePositiveInteger(firstMessageId, { name: "firstMessageId" });
  const normalizedLastMessageId = normalizePositiveInteger(lastMessageId, { name: "lastMessageId" });
  const normalizedChunkIndex = normalizeNonNegativeInteger(chunkIndex, { name: "chunkIndex" });
  const normalizedSourceKind = String(sourceKind || "").trim();
  const normalizedSourceHash = String(sourceHash || "").trim();
  const normalizedContent = String(content || "").trim();
  const normalizedEmbeddingText = String(embeddingText || "").trim();

  if (normalizedFirstMessageId > normalizedLastMessageId) throw new Error("Invalid chat RAG message range");
  if (!normalizedSourceKind) throw new Error("sourceKind is required");
  if (!normalizedSourceHash) throw new Error("sourceHash is required");
  if (!normalizedContent) throw new Error("content is required");
  if (!normalizedEmbeddingText) throw new Error("embeddingText is required");

  const query = `
    INSERT INTO chat_rag_chunks (
      user_id,
      preset_id,
      session_id,
      first_message_id,
      last_message_id,
      chunk_index,
      source_kind,
      source_hash,
      content,
      embedding_text,
      metadata,
      embedding,
      embedding_provider,
      embedding_model,
      embedding_dimensions
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13, $14, $15)
    ON CONFLICT (user_id, preset_id, session_id, first_message_id, last_message_id, chunk_index)
    DO UPDATE SET
      source_kind = EXCLUDED.source_kind,
      source_hash = EXCLUDED.source_hash,
      content = EXCLUDED.content,
      embedding_text = EXCLUDED.embedding_text,
      metadata = EXCLUDED.metadata,
      embedding = EXCLUDED.embedding,
      embedding_provider = EXCLUDED.embedding_provider,
      embedding_model = EXCLUDED.embedding_model,
      embedding_dimensions = EXCLUDED.embedding_dimensions,
      updated_at = NOW()
    RETURNING id;
  `;

  const params = [
    normalizedUserId,
    normalizedPresetId,
    normalizedSessionId,
    normalizedFirstMessageId,
    normalizedLastMessageId,
    normalizedChunkIndex,
    normalizedSourceKind,
    normalizedSourceHash,
    normalizedContent,
    normalizedEmbeddingText,
    normalizeMetadata(metadata),
    toVectorLiteral(embedding),
    chatRagConfig.embeddingProvider,
    chatRagConfig.embeddingModel,
    chatRagConfig.embeddingDimensions,
  ];

  const { rows } = await (client || db).query(query, params);
  return rows[0] || null;
}

async function deleteAllChunks(userId, presetId, { client } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const { rowCount } = await (client || db).query(
    "DELETE FROM chat_rag_chunks WHERE user_id = $1 AND preset_id = $2",
    [normalizedUserId, normalizedPresetId]
  );
  return rowCount || 0;
}

async function deleteChunksFromMessageId(userId, presetId, fromMessageId) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedFromMessageId = normalizePositiveInteger(fromMessageId, { name: "fromMessageId" });

  const query = `
    DELETE FROM chat_rag_chunks
    WHERE user_id = $1
      AND preset_id = $2
      AND last_message_id >= $3
  `;
  const { rowCount } = await db.query(query, [normalizedUserId, normalizedPresetId, normalizedFromMessageId]);
  return rowCount || 0;
}

async function listExistingTurnKeys({ userId, presetId } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);

  const query = `
    SELECT DISTINCT first_message_id, last_message_id
    FROM chat_rag_chunks
    WHERE user_id = $1
      AND preset_id = $2
  `;
  const { rows } = await db.query(query, [normalizedUserId, normalizedPresetId]);
  const keys = new Set();
  for (const row of rows) {
    keys.add(`${Number(row.first_message_id)}-${Number(row.last_message_id)}`);
  }
  return keys;
}

async function searchSimilarChunks({ userId, presetId, beforeMessageId, embedding, limit, minSimilarity, candidateLimit } = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedBeforeMessageId = normalizePositiveInteger(beforeMessageId, { name: "beforeMessageId" });
  const normalizedLimit = normalizePositiveInteger(limit, { name: "limit" });
  const normalizedCandidateLimit = candidateLimit != null
    ? normalizePositiveInteger(candidateLimit, { name: "candidateLimit" })
    : normalizedLimit;
  const normalizedMinSimilarity = Number(minSimilarity);
  if (!Number.isFinite(normalizedMinSimilarity) || normalizedMinSimilarity < 0 || normalizedMinSimilarity > 1) {
    throw new Error("Invalid minSimilarity");
  }

  const query = `
    SELECT
      id,
      session_id,
      first_message_id,
      last_message_id,
      chunk_index,
      source_kind,
      source_hash,
      content,
      embedding,
      metadata,
      created_at,
      updated_at,
      1 - (embedding <=> $4::vector) AS similarity
    FROM chat_rag_chunks
    WHERE user_id = $1
      AND preset_id = $2
      AND last_message_id <= $3
      AND EXISTS (
        SELECT 1 FROM chat_sessions active_session
        WHERE active_session.id = chat_rag_chunks.session_id
          AND active_session.user_id = $1
          AND active_session.preset_id = $2
          AND active_session.deleted_at IS NULL
      )
      AND embedding_provider = $5
      AND embedding_model = $6
      AND embedding_dimensions = $7
      AND 1 - (embedding <=> $4::vector) >= $8
    ORDER BY embedding <=> $4::vector ASC, last_message_id DESC
    LIMIT $9
  `;

  const params = [
    normalizedUserId,
    normalizedPresetId,
    normalizedBeforeMessageId,
    toVectorLiteral(embedding),
    chatRagConfig.embeddingProvider,
    chatRagConfig.embeddingModel,
    chatRagConfig.embeddingDimensions,
    normalizedMinSimilarity,
    normalizedCandidateLimit,
  ];

  const { rows } = await db.query(query, params);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    chunkIndex: row.chunk_index,
    sourceKind: row.source_kind,
    sourceHash: row.source_hash,
    content: row.content,
    embedding: row.embedding,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    similarity: Number(row.similarity),
  }));
}

async function listMessagesAroundChunk({
  userId,
  presetId,
  sessionId,
  firstMessageId,
  lastMessageId,
  beforeMessages,
  afterMessages,
} = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, { name: "userId" });
  const normalizedPresetId = normalizePresetId(presetId);
  const normalizedSessionId = normalizePositiveInteger(sessionId, { name: "sessionId" });
  const normalizedFirstMessageId = normalizePositiveInteger(firstMessageId, { name: "firstMessageId" });
  const normalizedLastMessageId = normalizePositiveInteger(lastMessageId, { name: "lastMessageId" });
  const normalizedBeforeMessages = normalizeNonNegativeInteger(beforeMessages, { name: "beforeMessages" });
  const normalizedAfterMessages = normalizeNonNegativeInteger(afterMessages, { name: "afterMessages" });

  if (normalizedFirstMessageId > normalizedLastMessageId) throw new Error("Invalid chat RAG message range");

  const baseParams = [normalizedUserId, normalizedPresetId, normalizedSessionId];
  let beforeRows = [];
  let afterRows = [];

  if (normalizedBeforeMessages > 0) {
    const result = await db.query(
      `
        SELECT id, role, content, created_at
        FROM chat_messages
        WHERE user_id = $1
          AND preset_id = $2
          AND session_id = $3
          AND id < $4
        ORDER BY id DESC
        LIMIT $5
      `,
      [...baseParams, normalizedFirstMessageId, normalizedBeforeMessages]
    );
    beforeRows = result.rows.slice().reverse();
  }

  const currentResult = await db.query(
    `
      SELECT id, role, content, created_at
      FROM chat_messages
      WHERE user_id = $1
        AND preset_id = $2
        AND session_id = $3
        AND id BETWEEN $4 AND $5
      ORDER BY id ASC
    `,
    [...baseParams, normalizedFirstMessageId, normalizedLastMessageId]
  );

  if (normalizedAfterMessages > 0) {
    const result = await db.query(
      `
        SELECT id, role, content, created_at
        FROM chat_messages
        WHERE user_id = $1
          AND preset_id = $2
          AND session_id = $3
          AND id > $4
        ORDER BY id ASC
        LIMIT $5
      `,
      [...baseParams, normalizedLastMessageId, normalizedAfterMessages]
    );
    afterRows = result.rows;
  }

  return [...beforeRows, ...currentResult.rows, ...afterRows]
    .map(mapMessageRow)
    .filter((row) => row.id > 0 && row.role && row.content);
}

module.exports = {
  upsertChunk,
  deleteAllChunks,
  deleteChunksFromMessageId,
  listExistingTurnKeys,
  searchSimilarChunks,
  listMessagesAroundChunk,
};
