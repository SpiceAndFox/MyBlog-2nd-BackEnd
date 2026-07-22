const BUILT_IN_PRESETS = [
  {
    id: "default",
    name: "默认",
    systemPrompt: "你是一个专业、耐心、可靠的助手。",
    avatarUrl: null,
    isBuiltin: true,
  },
];

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.preset_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    isBuiltin: false,
  };
}

const BUILT_IN_PRESET_IDS = new Set(BUILT_IN_PRESETS.map((preset) => preset.id));

function isBuiltinPresetId(presetId) {
  const normalizedId = String(presetId || "").trim();
  return BUILT_IN_PRESET_IDS.has(normalizedId);
}

function findBuiltinPreset(presetId) {
  const normalizedId = String(presetId || "").trim();
  return BUILT_IN_PRESETS.find((preset) => preset.id === normalizedId) || null;
}

function withBuiltinMetadata(preset) {
  if (!preset) return null;
  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt || "",
    avatarUrl: preset.avatarUrl || null,
    createdAt: null,
    updatedAt: null,
    isBuiltin: true,
  };
}

function createChatPresetRepository({ database } = {}) {
  if (!database?.query || !database?.getClient) throw new Error("Chat preset repository requires a database adapter");
  const db = database;

  async function ensureBuiltinPresets(userId, presetIds = null) {
    if (!userId) return;
    const ids = Array.isArray(presetIds) ? presetIds.map((id) => String(id || "").trim()) : null;
    const targets = ids ? BUILT_IN_PRESETS.filter((preset) => ids.includes(preset.id)) : BUILT_IN_PRESETS;
    if (!targets.length) return;

    const query = `
      INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, preset_id) DO NOTHING
    `;

    for (const preset of targets) {
      await db.query(query, [userId, preset.id, preset.name, preset.systemPrompt || "", preset.avatarUrl || null]);
    }
  }

  const chatPresetModel = {
  BUILT_IN_PRESETS: BUILT_IN_PRESETS.map(withBuiltinMetadata).filter(Boolean),
  isBuiltinPresetId,
  ensureBuiltinPresets,

  async listPresets(userId) {
    await ensureBuiltinPresets(userId);
    const builtins = chatPresetModel.BUILT_IN_PRESETS;
    const builtinIds = [...BUILT_IN_PRESET_IDS];

    const query = `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND deleted_at IS NULL AND NOT (preset_id = ANY($2::text[]))
      ORDER BY updated_at DESC, preset_id ASC
    `;
    const { rows } = await db.query(query, [userId, builtinIds]);
    const customs = rows.map(mapRow).filter(Boolean);

    return [...builtins, ...customs];
  },

  async getPreset(userId, presetId, { includeDeleted = false } = {}) {
    if (isBuiltinPresetId(presetId)) {
      await ensureBuiltinPresets(userId, [presetId]);
      return withBuiltinMetadata(findBuiltinPreset(presetId));
    }

    const query = includeDeleted
      ? `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND preset_id = $2
    `
      : `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NULL
    `;
    const { rows } = await db.query(query, [userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async createPreset(userId, { id, name, systemPrompt, avatarUrl } = {}) {
    if (isBuiltinPresetId(id)) {
      const error = new Error("Builtin preset id is reserved");
      error.code = "BUILTIN_PRESET_ID";
      throw error;
    }

    const query = `
      INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, id, name, systemPrompt || "", avatarUrl || null]);
    return mapRow(rows[0]) || null;
  },

  async updatePreset(userId, presetId, { name, systemPrompt, avatarUrl } = {}) {
    if (isBuiltinPresetId(presetId)) {
      const error = new Error("Builtin preset cannot be updated");
      error.code = "BUILTIN_PRESET_READONLY";
      throw error;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows: existingRows } = await client.query(
        `
          SELECT preset_id, system_prompt
          FROM chat_prompt_presets
          WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `,
        [userId, presetId]
      );
      if (existingRows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const previousSystemPrompt = String(existingRows[0]?.system_prompt ?? "");
      const nextSystemPrompt = typeof systemPrompt === "string" ? systemPrompt : previousSystemPrompt;

      const { rows } = await client.query(
        `
          UPDATE chat_prompt_presets
          SET name = COALESCE($1, name),
              system_prompt = $2,
              avatar_url = COALESCE($3, avatar_url),
              updated_at = NOW()
          WHERE user_id = $4 AND preset_id = $5 AND deleted_at IS NULL
          RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
        `,
        [name ?? null, nextSystemPrompt, avatarUrl ?? null, userId, presetId]
      );

      const updated = mapRow(rows[0]) || null;

      const shouldUpdateSessions =
        Boolean(updated) &&
        typeof systemPrompt === "string" &&
        nextSystemPrompt !== previousSystemPrompt;

      if (updated) {
        updated.systemPromptChanged = shouldUpdateSessions;
      }

      if (shouldUpdateSessions) {
        await client.query(
          `
            UPDATE chat_sessions
            SET settings = jsonb_set(
                  jsonb_set(settings, '{systemPromptPresetId}', to_jsonb($1::text), true),
                  '{systemPrompt}', to_jsonb($2::text), true
                ),
                updated_at = NOW()
            WHERE user_id = $3 AND preset_id = $1
          `,
          [presetId, updated.systemPrompt || "", userId]
        );
      }

      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async updatePresetAvatar(userId, presetId, avatarUrl) {
    if (isBuiltinPresetId(presetId)) return null;

    const query = `
      UPDATE chat_prompt_presets
      SET avatar_url = $1, updated_at = NOW()
      WHERE user_id = $2 AND preset_id = $3 AND deleted_at IS NULL
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
    `;
    const { rows } = await db.query(query, [avatarUrl, userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async deletePreset(userId, presetId) {
    if (isBuiltinPresetId(presetId)) {
      const error = new Error("Builtin preset cannot be deleted");
      error.code = "BUILTIN_PRESET_READONLY";
      throw error;
    }

    const { rowCount } = await db.query(
      `
        UPDATE chat_prompt_presets
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NULL
      `,
      [userId, presetId]
    );

    return { deleted: rowCount > 0, fallbackPresetId: null };
  },

  async listTrashedPresets(userId) {
    const builtinIds = [...BUILT_IN_PRESET_IDS];
    const query = `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND deleted_at IS NOT NULL AND NOT (preset_id = ANY($2::text[]))
      ORDER BY deleted_at DESC, updated_at DESC, preset_id ASC
    `;
    const { rows } = await db.query(query, [userId, builtinIds]);
    return rows.map(mapRow).filter(Boolean);
  },

  async restorePreset(userId, presetId) {
    if (isBuiltinPresetId(presetId)) return null;

    const query = `
      UPDATE chat_prompt_presets
      SET deleted_at = NULL, updated_at = NOW()
      WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NOT NULL
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at, deleted_at
    `;
    const { rows } = await db.query(query, [userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async deletePresetPermanently(userId, presetId, { client } = {}) {
    if (isBuiltinPresetId(presetId)) return false;

    const query = `
      DELETE FROM chat_prompt_presets
      WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NOT NULL
      RETURNING avatar_url
    `;
    const { rows } = await (client || db).query(query, [userId, presetId]);
    if (!rows[0]) return null;
    return { deleted: true, avatarUrl: rows[0].avatar_url || null };
  },
  };

  return Object.freeze(chatPresetModel);
}

module.exports = { createChatPresetRepository };
