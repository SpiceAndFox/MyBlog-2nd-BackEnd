function normalizePresetId(rawPresetId) {
  const normalized = String(rawPresetId || "").trim();
  return normalized || null;
}

function normalizeMessageId(rawMessageId) {
  if (rawMessageId === null || rawMessageId === undefined) return null;
  const value = Number(rawMessageId);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizeMessageIds(messageIds) {
  const list = Array.isArray(messageIds) ? messageIds : [];
  const unique = new Set();
  for (const item of list) {
    const normalized = normalizeMessageId(item);
    if (normalized === null) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function mapRow(row) {
  if (!row) return null;
  return {
    messageId: Number(row.message_id) || 0,
    userId: row.user_id,
    presetId: row.preset_id,
    gistText: row.gist_text || "",
    contentHash: row.content_hash || "",
    providerId: row.provider_id || "",
    modelId: row.model_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createChatGistRepository({ database } = {}) {
  if (!database?.query) throw new Error("Chat gist repository requires a database adapter");
  const db = database;
  const executor = (client) => (client && typeof client.query === "function" ? client : database);

  const chatMessageGistModel = {
  async getGist(userId, presetId, messageId) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) throw new Error("messageId must be a non-negative integer");

    const query = `
      SELECT message_id, user_id, preset_id, gist_text, content_hash, provider_id, model_id, created_at, updated_at
      FROM chat_message_gists
      WHERE user_id = $1 AND preset_id = $2 AND message_id = $3
      LIMIT 1
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedMessageId]);
    return mapRow(rows[0]) || null;
  },

  async listGistsByMessageIds(userId, presetId, messageIds) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");
    const normalizedIds = normalizeMessageIds(messageIds);
    if (!normalizedIds.length) return [];

    const query = `
      SELECT message_id, user_id, preset_id, gist_text, content_hash, provider_id, model_id, created_at, updated_at
      FROM chat_message_gists
      WHERE user_id = $1 AND preset_id = $2 AND message_id = ANY($3)
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedIds]);
    return rows.map(mapRow).filter(Boolean);
  },

  async upsertGist(userId, presetId, messageId, { gistText, contentHash, providerId, modelId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) throw new Error("messageId must be a non-negative integer");

    const normalizedGistText = String(gistText || "").trim();
    const normalizedContentHash = String(contentHash || "").trim();
    const normalizedProviderId = String(providerId || "").trim();
    const normalizedModelId = String(modelId || "").trim();

    if (!normalizedGistText) throw new Error("gistText is required");
    if (!normalizedContentHash) throw new Error("contentHash is required");
    if (!normalizedProviderId) throw new Error("providerId is required");
    if (!normalizedModelId) throw new Error("modelId is required");

    const query = `
      INSERT INTO chat_message_gists (message_id, user_id, preset_id, gist_text, content_hash, provider_id, model_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (message_id) DO UPDATE
      SET gist_text = EXCLUDED.gist_text,
          content_hash = EXCLUDED.content_hash,
          provider_id = EXCLUDED.provider_id,
          model_id = EXCLUDED.model_id,
          updated_at = NOW()
      RETURNING message_id, user_id, preset_id, gist_text, content_hash, provider_id, model_id, created_at, updated_at
    `;
    const { rows } = await db.query(query, [
      normalizedMessageId,
      userId,
      normalizedPresetId,
      normalizedGistText,
      normalizedContentHash,
      normalizedProviderId,
      normalizedModelId,
    ]);
    return mapRow(rows[0]) || null;
  },

  async deleteByScope(userId, presetId, { client } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");
    try {
      const { rowCount } = await executor(client).query(
        `DELETE FROM chat_message_gists WHERE user_id=$1 AND preset_id=$2`,
        [userId, normalizedPresetId],
      );
      return rowCount || 0;
    } catch (error) {
      if (error?.code === "42P01") return 0;
      throw error;
    }
  },

  async countByScope(userId, presetId, { client } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");
    try {
      const { rows } = await executor(client).query(
        `SELECT COUNT(*)::BIGINT AS count FROM chat_message_gists WHERE user_id=$1 AND preset_id=$2`,
        [userId, normalizedPresetId],
      );
      return Number(rows[0]?.count || 0);
    } catch (error) {
      if (error?.code === "42P01") return 0;
      throw error;
    }
  },
  };

  return Object.freeze(chatMessageGistModel);
}

module.exports = { createChatGistRepository };
