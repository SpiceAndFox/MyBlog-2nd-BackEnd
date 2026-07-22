#!/usr/bin/env node
require("module-alias/register");
const { createCommandContext } = require("./app/composition/commandContext");
const { database: db, config: { chatConfig, chatContextConfig } } = createCommandContext();
const { buildRecentWindowContext } = require("./services/chat/context/buildRecentWindowContext");
const { requestAssistantGistGeneration } = require("./services/chat/gistPipeline");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw || !raw.startsWith("--")) continue;
    const key = raw.slice(2).trim();
    if (!key) continue;

    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      parsed[key] = next;
      i += 1;
      continue;
    }

    parsed[key] = true;
  }
  return parsed;
}

function parsePositiveInt(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function parseNonNegativeInt(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function printUsage() {
  console.log(`
Usage:
  node regenerateGists.js --user <userId> --preset <presetId> [--scope recent-window|all-gists] [--up-to <messageId>] [--limit <n>] [--all] [--dry-run]

Examples:
  # Regenerate gists used by current recent_window (recommended / small)
  node regenerateGists.js --user 1 --preset default

  # Regenerate gists for recent_window at a specific message id (useful when debugging edits)
  node regenerateGists.js --user 1 --preset default --up-to 12345

  # Regenerate existing gist rows for a preset (in batches)
  node regenerateGists.js --user 1 --preset default --scope all-gists --limit 200

  # Regenerate all existing gist rows for a preset (may be slow / costly)
  node regenerateGists.js --user 1 --preset default --scope all-gists --all --limit 200
`.trim());
}

async function listRecentWindowGistCandidates({ userId, presetId, upToMessageId } = {}) {
  const maxMessages = chatConfig.recentWindowMaxMessages;
  const candidateLimit = maxMessages + 1;

  const recentWindowContext = await buildRecentWindowContext({ userId, presetId, upToMessageId });
  const candidates = recentWindowContext.recentCandidates;
  const recentWindow = recentWindowContext.recent;

  const list = Array.isArray(recentWindow?.assistantGistCandidates) ? recentWindow.assistantGistCandidates : [];

  return {
    list,
    stats: {
      candidateLimit,
      candidatesCount: candidates.length,
      windowStartMessageId: recentWindow?.stats?.windowStartMessageId ?? null,
      windowEndMessageId: recentWindow?.stats?.windowEndMessageId ?? null,
      assistantRawLastN: chatContextConfig.recentWindowAssistantRawLastN,
      assistantCandidates: list.length,
    },
  };
}

async function listGistMessageIdsBatch({ userId, presetId, beforeMessageId, limit } = {}) {
  const normalizedLimit = Math.max(1, Math.min(1000, Number.parseInt(String(limit), 10) || 200));
  const normalizedBeforeId = beforeMessageId === null || beforeMessageId === undefined ? null : Number(beforeMessageId);

  const params = [userId, presetId];
  let where = "WHERE user_id = $1 AND preset_id = $2";

  if (Number.isFinite(normalizedBeforeId) && normalizedBeforeId > 0) {
    params.push(Math.floor(normalizedBeforeId));
    where += ` AND message_id < $${params.length}`;
  }

  params.push(normalizedLimit);
  const query = `
    SELECT message_id
    FROM chat_message_gists
    ${where}
    ORDER BY message_id DESC
    LIMIT $${params.length}
  `;

  const { rows } = await db.query(query, params);
  return rows.map((row) => Number(row.message_id)).filter((id) => Number.isFinite(id) && id > 0);
}

async function loadAssistantMessagesByIds({ userId, presetId, messageIds } = {}) {
  const ids = Array.isArray(messageIds) ? messageIds.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0) : [];
  if (!ids.length) return [];

  const query = `
    SELECT m.id, m.content
    FROM chat_messages m
    INNER JOIN chat_sessions s ON s.id = m.session_id
    WHERE m.user_id = $1
      AND m.preset_id = $2
      AND m.role = 'assistant'
      AND m.id = ANY($3)
      AND s.user_id = $1
      AND s.deleted_at IS NULL
    ORDER BY m.id DESC
  `;

  const { rows } = await db.query(query, [userId, presetId, ids]);
  return rows
    .map((row) => ({
      messageId: Number(row.id) || 0,
      content: String(row.content || "").trim(),
    }))
    .filter((row) => row.messageId > 0 && row.content);
}

async function regenerateGistsForMessages({ userId, presetId, messages, dryRun = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { total: 0, ok: 0, failed: 0 };

  if (dryRun) {
    console.log(`dry-run: would regenerate ${list.length} gists (force=true)`);
    console.log(list.map((row) => row.messageId).join(", "));
    return { total: list.length, ok: 0, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  const total = list.length;

  const tasks = list.map((row) => {
    const messageId = Number(row.messageId);
    const content = String(row.content || "").trim();
    if (!Number.isFinite(messageId) || messageId <= 0 || !content) {
      failed += 1;
      return Promise.resolve();
    }

    const task = requestAssistantGistGeneration({
      userId,
      presetId,
      messageId,
      content,
      force: true,
    });

    return Promise.resolve(task)
      .then(() => {
        ok += 1;
        process.stdout.write(`\rprogress: ${ok + failed}/${total}`);
      })
      .catch((error) => {
        failed += 1;
        const message = error?.message || String(error || "");
        console.error(`\nfailed to regenerate gist for message_id=${messageId}: ${message}`);
      });
  });

  await Promise.allSettled(tasks);
  process.stdout.write("\n");

  return { total, ok, failed };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const userId = parsePositiveInt(args.user || args.userId);
  const presetId = String(args.preset || args.presetId || "").trim();
  const scope = String(args.scope || "recent-window").trim();
  const upToMessageId = parseNonNegativeInt(args["up-to"] ?? args.upTo ?? args.upToMessageId);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const limit = parsePositiveInt(args.limit) || 200;
  const runAll = Boolean(args.all);

  if (!userId || !presetId) {
    printUsage();
    process.exit(1);
  }

  try {
    if (scope === "recent-window") {
      const { list, stats } = await listRecentWindowGistCandidates({ userId, presetId, upToMessageId });
      console.log("recent-window stats:", stats);
      const result = await regenerateGistsForMessages({
        userId,
        presetId,
        messages: list,
        dryRun,
      });
      console.log("done:", result);
      return;
    }

    if (scope === "all-gists") {
      let beforeMessageId = upToMessageId === null ? null : upToMessageId;
      let total = 0;
      let ok = 0;
      let failed = 0;
      let batch = 0;

      do {
        batch += 1;
        const gistMessageIds = await listGistMessageIdsBatch({ userId, presetId, beforeMessageId, limit });
        if (!gistMessageIds.length) break;

        const messages = await loadAssistantMessagesByIds({ userId, presetId, messageIds: gistMessageIds });
        if (!messages.length) {
          beforeMessageId = Math.min(...gistMessageIds);
          continue;
        }

        console.log(`batch ${batch}: regenerating ${messages.length} gists (force=true) ...`);
        const result = await regenerateGistsForMessages({ userId, presetId, messages, dryRun });
        total += result.total;
        ok += result.ok;
        failed += result.failed;

        beforeMessageId = Math.min(...gistMessageIds);
      } while (runAll && !dryRun);

      console.log("done:", { total, ok, failed, scope, limit, all: runAll });
      return;
    }

    throw new Error(`Unknown --scope: ${scope} (expected recent-window|all-gists)`);
  } catch (error) {
    const message = error?.message || String(error || "");
    console.error(`error: ${message}`);
    process.exitCode = 1;
  } finally {
    db.end();
  }
})();
