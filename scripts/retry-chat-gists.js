function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!["--userId", "--presetId", "--messageId"].includes(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(`Invalid argument: ${key}`);
    values[key] = value;
  }
  const userId = Number(values["--userId"]);
  const presetId = String(values["--presetId"] || "").trim();
  const messageId = values["--messageId"] === undefined ? null : Number(values["--messageId"]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId || messageId !== null && (!Number.isSafeInteger(messageId) || messageId <= 0)) {
    throw new Error("Usage: npm run retry:chat-gists -- --userId <id> --presetId <id> [--messageId <id>]");
  }
  return { userId, presetId, messageId };
}

async function main(argv = process.argv.slice(2)) {
  const { userId, presetId, messageId } = parseArgs(argv);
  const { createCommandContext } = require("../app/composition/commandContext");
  const { createChatPersistence } = require("../modules/chat");
  const { createChatGistService } = require("../modules/chat/admin");
  const c = createCommandContext();
  let worker;
  try {
    if (!c.config.chatGistConfig.enabled) throw new Error("CHAT_GIST_ENABLED is false");
    const { gistRepository } = createChatPersistence({ database: c.database });
    worker = createChatGistService({ config: c.config.chatGistConfig, contextConfig: c.config.chatContextConfig,
      gistRepository, llm: { complete: c.chatLlm.createChatCompletion }, logger: c.logger });
    const { rows } = await c.database.query(`SELECT message_id FROM chat_gist_tasks
      WHERE user_id=$1 AND preset_id=$2 AND status='failed' AND ($3::BIGINT IS NULL OR message_id=$3)
      ORDER BY message_id`, [userId, presetId, messageId]);
    for (const row of rows) {
      const outcome = await worker.requestGeneration({ userId, presetId, messageId: row.message_id, force: true });
      process.stdout.write(JSON.stringify({ messageId: row.message_id, status: outcome?.status || "source_unavailable", nextRetryAt: outcome?.next_retry_at || null }) + "\n");
    }
    process.stdout.write(`Retried ${rows.length} failed gist task(s). Pending retries continue in the application worker.\n`);
  } finally { await worker?.stop(); await c.database.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseArgs };
