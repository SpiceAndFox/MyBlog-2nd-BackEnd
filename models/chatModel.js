const db = require("../db");

const DEFAULT_SESSION_TITLE = "新对话";

function normalizeTitle(rawTitle) {
  const normalized = String(rawTitle || "").trim();
  return normalized || DEFAULT_SESSION_TITLE;
}

function normalizeSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) return {};
  return rawSettings;
}

function normalizePresetId(rawPresetId) {
  const normalized = String(rawPresetId || "").trim();
  return normalized || null;
}

function executor(client) {
  return client && typeof client.query === "function" ? client : db;
}

const chatModel = {
  async listSessions(userId) {
    const query = `
      SELECT id, preset_id, title, settings, created_at, updated_at
      FROM chat_sessions
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async listTrashedSessions(userId) {
    const query = `
      SELECT id, preset_id, title, settings, created_at, updated_at, deleted_at
      FROM chat_sessions
      WHERE user_id = $1 AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC, updated_at DESC, id DESC
    `;
    const { rows } = await db.query(query, [userId]);
    return rows;
  },

  async getSession(userId, sessionId) {
    const query = `
      SELECT id, preset_id, title, settings, created_at, updated_at
      FROM chat_sessions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
    `;
    const { rows } = await db.query(query, [sessionId, userId]);
    return rows[0] || null;
  },

  async createSession(userId, { title, settings, presetId } = {}) {
    const normalizedTitle = normalizeTitle(title);
    const normalizedSettings = normalizeSettings(settings);
    const normalizedPresetId = String(presetId || "").trim();
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      INSERT INTO chat_sessions (user_id, preset_id, title, settings)
      VALUES ($1, $2, $3, $4)
      RETURNING id, preset_id, title, settings, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedTitle, normalizedSettings]);
    return rows[0];
  },

  async updateSessionSettings(userId, sessionId, settings, presetId) {
    const normalizedSettings = normalizeSettings(settings);
    const normalizedPresetId = typeof presetId === "string" ? presetId.trim() : "";
    const query = normalizedPresetId
      ? `
      UPDATE chat_sessions
      SET settings = $1, preset_id = $2, updated_at = NOW()
      WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL
      RETURNING id, preset_id, title, settings, created_at, updated_at
    `
      : `
      UPDATE chat_sessions
      SET settings = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
      RETURNING id, preset_id, title, settings, created_at, updated_at
    `;
    const params = normalizedPresetId
      ? [normalizedSettings, normalizedPresetId, sessionId, userId]
      : [normalizedSettings, sessionId, userId];
    const { rows } = await db.query(query, params);
    return rows[0] || null;
  },

  async touchSession(userId, sessionId) {
    const query = `
      UPDATE chat_sessions
      SET updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING id, preset_id, title, settings, created_at, updated_at
    `;
    const { rows } = await db.query(query, [sessionId, userId]);
    return rows[0] || null;
  },

  async trashSession(userId, sessionId, { client } = {}) {
    const query = `
      UPDATE chat_sessions
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING id, preset_id, title, settings, created_at, updated_at, deleted_at
    `;
    const { rows } = await executor(client).query(query, [sessionId, userId]);
    return rows[0] || null;
  },

  async getTrashedSession(userId, sessionId) {
    const query = `
      SELECT id, preset_id, title, settings, created_at, updated_at, deleted_at
      FROM chat_sessions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
    `;
    const { rows } = await db.query(query, [sessionId, userId]);
    return rows[0] || null;
  },

  async restoreSession(userId, sessionId, { client } = {}) {
    const query = `
      UPDATE chat_sessions
      SET deleted_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
      RETURNING id, preset_id, title, settings, created_at, updated_at, deleted_at
    `;
    const { rows } = await executor(client).query(query, [sessionId, userId]);
    return rows[0] || null;
  },

  async getSessionMessageIdRange(userId, sessionId) {
    const query = `
      SELECT MIN(id) AS min_id,
             MAX(id) AS max_id
      FROM chat_messages
      WHERE session_id = $1 AND user_id = $2
    `;
    const { rows } = await db.query(query, [sessionId, userId]);
    const row = rows[0] || {};

    const min = row.min_id === null || row.min_id === undefined ? null : Number(row.min_id);
    const max = row.max_id === null || row.max_id === undefined ? null : Number(row.max_id);

    const minId = Number.isFinite(min) ? min : null;
    const maxId = Number.isFinite(max) ? max : null;

    if (minId === null && maxId === null) return null;
    return { minMessageId: minId, maxMessageId: maxId };
  },

  async deleteSessionPermanently(userId, sessionId, { client: providedClient } = {}) {
    const client = providedClient || await db.getClient();
    const ownsTransaction = !providedClient;
    try {
      if (ownsTransaction) await client.query("BEGIN");

      const sessionQuery = `
        SELECT id, preset_id
        FROM chat_sessions
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
        LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery, [sessionId, userId]);
      const session = sessionResult.rows[0] || null;
      if (!session) {
        if (ownsTransaction) await client.query("ROLLBACK");
        return null;
      }

      const rangeQuery = `
        SELECT MIN(id) AS min_id
        FROM chat_messages
        WHERE session_id = $1 AND user_id = $2
      `;
      const rangeResult = await client.query(rangeQuery, [sessionId, userId]);
      const minIdRaw = rangeResult.rows[0]?.min_id;
      const minId = minIdRaw === null || minIdRaw === undefined ? null : Number(minIdRaw);
      const firstMessageId = Number.isFinite(minId) ? minId : null;

      const deleteQuery = `
        DELETE FROM chat_sessions
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
      `;
      const deleteResult = await client.query(deleteQuery, [sessionId, userId]);
      if (deleteResult.rowCount <= 0) {
        if (ownsTransaction) await client.query("ROLLBACK");
        return null;
      }

      if (ownsTransaction) await client.query("COMMIT");
      return {
        id: session.id,
        preset_id: session.preset_id,
        firstMessageId,
      };
    } catch (error) {
      if (ownsTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
      }
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  },

  async listTrashedSessionPurgeCandidates(cutoff, { limit } = {}) {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new Error("Invalid cutoff date");
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) throw new Error("Invalid purge limit");
    const { rows } = await db.query(`
      SELECT id, user_id, preset_id
      FROM chat_sessions
      WHERE deleted_at IS NOT NULL AND deleted_at < $1
      ORDER BY deleted_at ASC, id ASC
      LIMIT $2
    `, [cutoff, limit]);
    return rows.map((row) => ({ id: Number(row.id), userId: Number(row.user_id), presetId: String(row.preset_id) }));
  },

  async purgeTrashedSessionIds(userId, presetId, sessionIds, { client } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    const ids = Array.isArray(sessionIds) ? sessionIds.map(Number) : [];
    if (!normalizedPresetId || !ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("Invalid trashed session purge scope");
    }
    const { rowCount } = await executor(client).query(`
      DELETE FROM chat_sessions
      WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NOT NULL AND id = ANY($3::BIGINT[])
    `, [userId, normalizedPresetId, ids]);
    return rowCount || 0;
  },

  async listMessages(userId, sessionId) {
    const session = await this.getSession(userId, sessionId);
    if (!session) return null;

    const query = `
      SELECT id, preset_id, role, content, created_at
      FROM chat_messages
      WHERE session_id = $1 AND user_id = $2
      ORDER BY id ASC
    `;
    const { rows } = await db.query(query, [sessionId, userId]);
    return rows;
  },

  async getMessage(userId, sessionId, messageId) {
    const query = `
      SELECT id, preset_id, role, content, created_at
      FROM chat_messages
      WHERE id = $1 AND session_id = $2 AND user_id = $3
    `;
    const { rows } = await db.query(query, [messageId, sessionId, userId]);
    return rows[0] || null;
  },

  async listRecentMessages(userId, sessionId, limit = 20) {
    const session = await this.getSession(userId, sessionId);
    if (!session) return null;

    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20;

    const query = `
      SELECT id, preset_id, role, content, created_at
      FROM chat_messages
      WHERE session_id = $1 AND user_id = $2
      ORDER BY id DESC
      LIMIT $3
    `;
    const { rows } = await db.query(query, [sessionId, userId, normalizedLimit]);
    return rows.reverse();
  },

  async listRecentMessagesUpTo(userId, sessionId, messageId, limit = 20) {
    const session = await this.getSession(userId, sessionId);
    if (!session) return null;

    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20;

    const query = `
      SELECT id, preset_id, role, content, created_at
      FROM chat_messages
      WHERE session_id = $1 AND user_id = $2 AND id <= $3
      ORDER BY id DESC
      LIMIT $4
    `;
    const { rows } = await db.query(query, [sessionId, userId, messageId, normalizedLimit]);
    return rows.reverse();
  },

  async listMessagesByPreset(userId, presetId) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      SELECT m.id, m.preset_id, m.role, m.content, m.created_at
      FROM chat_messages m
      INNER JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.user_id = $1 AND m.preset_id = $2 AND s.user_id = $1 AND s.deleted_at IS NULL
      ORDER BY m.created_at ASC, m.id ASC
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId]);
    return rows;
  },

  async listMessagesByPresetUpTo(userId, presetId, messageId) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      SELECT m.id, m.preset_id, m.role, m.content, m.created_at
      FROM chat_messages m
      INNER JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.user_id = $1 AND m.preset_id = $2 AND m.id <= $3 AND s.user_id = $1 AND s.deleted_at IS NULL
      ORDER BY m.created_at ASC, m.id ASC
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, messageId]);
    return rows;
  },

  async listRecentMessagesByPreset(userId, presetId, { limit = 50, upToMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
    const normalizedUpToMessageId =
      upToMessageId === undefined || upToMessageId === null
        ? null
        : Number.isFinite(Number(upToMessageId))
        ? Math.max(0, Math.floor(Number(upToMessageId)))
        : null;

    if (normalizedUpToMessageId === 0) return [];

    const query = normalizedUpToMessageId !== null
      ? `
      SELECT m.id, m.preset_id, m.role, m.content, m.created_at
      FROM chat_messages m
      INNER JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.user_id = $1
        AND m.preset_id = $2
        AND m.id <= $3
        AND s.user_id = $1
        AND s.deleted_at IS NULL
      ORDER BY m.id DESC
      LIMIT $4
    `
      : `
      SELECT m.id, m.preset_id, m.role, m.content, m.created_at
      FROM chat_messages m
      INNER JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.user_id = $1
        AND m.preset_id = $2
        AND s.user_id = $1
        AND s.deleted_at IS NULL
      ORDER BY m.id DESC
      LIMIT $3
    `;

    const params =
      normalizedUpToMessageId !== null
        ? [userId, normalizedPresetId, normalizedUpToMessageId, normalizedLimit]
        : [userId, normalizedPresetId, normalizedLimit];
    const { rows } = await db.query(query, params);
    return rows.reverse();
  },

  async listMessagesByPresetAfter(userId, presetId, { afterMessageId = 0, limit = 50 } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedAfterId = Number.isFinite(Number(afterMessageId)) ? Math.max(0, Math.floor(Number(afterMessageId))) : 0;
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;

    const query = `
      SELECT m.id, m.preset_id, m.role, m.content, m.created_at
      FROM chat_messages m
      INNER JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.user_id = $1
        AND m.preset_id = $2
        AND m.id > $3
        AND s.user_id = $1
        AND s.deleted_at IS NULL
      ORDER BY m.id ASC
      LIMIT $4
    `;

    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedAfterId, normalizedLimit]);
    return rows;
  },

  async createMessage(userId, sessionId, role, content) {
    const normalizedRole = String(role || "").trim();
    const normalizedContent = String(content || "").trim();
    if (!normalizedRole) throw new Error("Role is required");
    if (!normalizedContent) throw new Error("Content is required");

    const query = `
      INSERT INTO chat_messages (session_id, user_id, preset_id, role, content)
      SELECT s.id, $2, s.preset_id, $3, $4
      FROM chat_sessions s
      WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
      RETURNING id, preset_id, role, content, created_at
    `;
    const { rows } = await db.query(query, [sessionId, userId, normalizedRole, normalizedContent]);
    return rows[0] || null;
  },

  async updateMessageContent(userId, sessionId, messageId, content, { client } = {}) {
    const normalizedContent = String(content || "").trim();
    if (!normalizedContent) throw new Error("Content is required");

    const query = `
      UPDATE chat_messages
      SET content = $1
      WHERE id = $2 AND session_id = $3 AND user_id = $4
      RETURNING id, preset_id, role, content, created_at
    `;
    const { rows } = await executor(client).query(query, [normalizedContent, messageId, sessionId, userId]);
    return rows[0] || null;
  },

  async deleteMessagesAfter(userId, sessionId, messageId, { client } = {}) {
    const query = `
      DELETE FROM chat_messages
      WHERE session_id = $1 AND user_id = $2 AND id > $3
    `;
    const { rowCount } = await executor(client).query(query, [sessionId, userId, messageId]);
    return rowCount || 0;
  },
};

module.exports = chatModel;
