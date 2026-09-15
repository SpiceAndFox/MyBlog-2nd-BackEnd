const { randomUUID } = require("node:crypto");
const { hashGistContent, gistSourceFingerprint } = require("../../domain/gistSource");
const { createTransactionExecutor } = require("../../../../shared/db/transactionExecutor");

// Read only live sources. The adjacent user is part of the input version too.
const SOURCE_SELECT = `SELECT m.id,m.user_id,m.preset_id,m.session_id,m.content,
  u.id AS user_message_id,u.content AS user_content
  FROM chat_messages m
  JOIN chat_sessions s ON s.id=m.session_id AND s.user_id=m.user_id
  JOIN chat_prompt_presets p ON p.user_id=m.user_id AND p.preset_id=m.preset_id
  LEFT JOIN LATERAL (
    SELECT x.id,x.content FROM chat_messages x
    WHERE x.user_id=m.user_id AND x.session_id=m.session_id AND x.preset_id=m.preset_id
      AND x.role='user' AND x.id<m.id
      AND (m.parent_user_message_id IS NULL OR x.id=m.parent_user_message_id)
    ORDER BY x.id DESC LIMIT 1
  ) u ON TRUE
  WHERE m.user_id=$1 AND m.preset_id=$2 AND m.id=$3 AND m.role='assistant'
    AND s.deleted_at IS NULL AND p.deleted_at IS NULL`;

function mapSource(row) {
  if (!row || !String(row.content || "").trim()) return null;
  const source = { userId: row.user_id, presetId: row.preset_id, messageId: row.id,
    content: row.content, userContent: row.user_content || "", userMessageId: row.user_message_id };
  return { ...source, sourceHash: gistSourceFingerprint(source), contentHash: hashGistContent(source.content) };
}

function createGistTaskRepository({ database }) {
  const run = work => createTransactionExecutor({ database }).run(work);

  async function readSource(scope, client = database, lock = false) {
    const params = [scope.userId ?? scope.user_id, scope.presetId ?? scope.preset_id, scope.messageId ?? scope.message_id];
    const first = (await client.query(SOURCE_SELECT, params)).rows[0];
    if (!first) return null;
    if (lock) {
      // Source locks precede task locks, and messages are locked in id order.
      // Edits/deletes cannot cross the final validation and gist commit.
      await client.query("SELECT preset_id FROM chat_prompt_presets WHERE user_id=$1 AND preset_id=$2 FOR SHARE", params.slice(0, 2));
      await client.query("SELECT id FROM chat_sessions WHERE id=$1 FOR SHARE", [first.session_id]);
      await client.query("SELECT id FROM chat_messages WHERE id=ANY($1::BIGINT[]) ORDER BY id FOR SHARE", [[first.id, first.user_message_id].filter(Boolean)]);
      const latest = (await client.query(SOURCE_SELECT, params)).rows[0];
      if (!latest || String(latest.session_id) !== String(first.session_id)
        || String(latest.user_message_id) !== String(first.user_message_id)) return null;
      return mapSource(latest);
    }
    return mapSource(first);
  }

  async function enqueueGistTask(scope, { force = false } = {}) {
    return run(async client => {
      const source = await readSource(scope, client, true);
      if (!source) return null;
      if (!force) {
        const cached = await client.query("SELECT 1 FROM chat_message_gists WHERE message_id=$1 AND user_id=$2 AND preset_id=$3 AND source_hash=$4", [source.messageId, source.userId, source.presetId, source.sourceHash]);
        if (cached.rows.length) return { status: "succeeded", message_id: source.messageId };
      }
      const { rows } = await client.query(`INSERT INTO chat_gist_tasks
        (message_id,user_id,preset_id,source_hash,content_hash,status)
        VALUES ($1,$2,$3,$4,$5,'queued')
        ON CONFLICT (message_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,
          content_hash=EXCLUDED.content_hash,status='queued',attempt=0,next_retry_at=NULL,
          lease_until=NULL,run_token=NULL,last_error_reason=NULL,updated_at=NOW()
        WHERE chat_gist_tasks.source_hash<>EXCLUDED.source_hash
          OR chat_gist_tasks.status IN ('succeeded','cancelled')
          OR ($6 AND chat_gist_tasks.status='failed')
        RETURNING *`, [source.messageId, source.userId, source.presetId, source.sourceHash, source.contentHash, force]);
      return rows[0] || (await client.query("SELECT * FROM chat_gist_tasks WHERE message_id=$1", [source.messageId])).rows[0];
    });
  }

  async function claimGistTask({ leaseMs, messageId = null }) {
    const { rows } = await database.query(`WITH due AS (
      SELECT message_id FROM chat_gist_tasks
      WHERE ($1::BIGINT IS NULL OR message_id=$1) AND (
        (status IN ('queued','retry_wait') AND (next_retry_at IS NULL OR next_retry_at<=NOW()))
        OR (status='running' AND lease_until<=NOW()))
      ORDER BY updated_at,message_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE chat_gist_tasks t SET status='running',attempt=t.attempt+1,
      run_token=$2,lease_until=NOW()+($3 * INTERVAL '1 millisecond'),updated_at=NOW()
      FROM due WHERE t.message_id=due.message_id RETURNING t.*`, [messageId, randomUUID(), leaseMs]);
    return rows[0] || null;
  }

  async function finishGistTask(task, { result, status, nextRetryAt = null, reason = null }) {
    return run(async client => {
      const source = await readSource(task, client, true);
      const current = (await client.query("SELECT * FROM chat_gist_tasks WHERE message_id=$1 AND run_token=$2 AND status='running' FOR UPDATE", [task.message_id, task.run_token])).rows[0];
      if (!current) return { status: "stale" };
      if (!source || source.sourceHash !== task.source_hash) {
        status = "cancelled"; reason = "source_changed"; result = null; nextRetryAt = null;
      }
      if (result) {
        await client.query(`INSERT INTO chat_message_gists
          (message_id,user_id,preset_id,gist_text,content_hash,source_hash,provider_id,model_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (message_id) DO UPDATE SET gist_text=EXCLUDED.gist_text,
            content_hash=EXCLUDED.content_hash,source_hash=EXCLUDED.source_hash,
            provider_id=EXCLUDED.provider_id,model_id=EXCLUDED.model_id,updated_at=NOW()`,
        [task.message_id, task.user_id, task.preset_id, result.gistText, task.content_hash, task.source_hash, result.providerId, result.modelId]);
        status = "succeeded";
      }
      await client.query(`UPDATE chat_gist_tasks SET status=$3,next_retry_at=$4,last_error_reason=$5,
        lease_until=NULL,run_token=NULL,updated_at=NOW() WHERE message_id=$1 AND run_token=$2`,
      [task.message_id, task.run_token, status, nextRetryAt, reason]);
      return { status, nextRetryAt, reason };
    });
  }

  async function deleteGistTasksByScope(userId, presetId, { client = database } = {}) {
    return (await client.query("DELETE FROM chat_gist_tasks WHERE user_id=$1 AND preset_id=$2", [userId, presetId])).rowCount;
  }
  async function getGistSources(userId, presetId, messageIds) {
    const { rows } = await database.query(SOURCE_SELECT.replace("m.id=$3", "m.id=ANY($3::BIGINT[])"), [userId, presetId, messageIds]);
    return rows.map(mapSource).filter(Boolean);
  }
  async function countGistTasksByScope(userId, presetId) {
    return Number((await database.query("SELECT COUNT(*) AS count FROM chat_gist_tasks WHERE user_id=$1 AND preset_id=$2", [userId, presetId])).rows[0].count);
  }
  async function getGistTask({ userId, presetId, messageId }) {
    return (await database.query("SELECT * FROM chat_gist_tasks WHERE user_id=$1 AND preset_id=$2 AND message_id=$3", [userId, presetId, messageId])).rows[0] || null;
  }
  return { enqueueGistTask, claimGistTask, finishGistTask, getGistSource: readSource,
    deleteGistTasksByScope, countGistTasksByScope, getGistSources, getGistTask };
}

module.exports = { createGistTaskRepository };
