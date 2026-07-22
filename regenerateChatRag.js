#!/usr/bin/env node
require("module-alias/register");
const { createCommandContext } = require("./app/composition/commandContext");
const commandContext = createCommandContext();
const { database: db, config, logger } = commandContext;
const { chatRagConfig, memoryV2Config } = config;
const { createChatRagComposition } = require("./app/composition/chatRag");
const { indexChatTurn, deleteChunksFromMessageId, listExistingTurnKeys } = createChatRagComposition({
  config,
  database: db,
  logger,
}).admin;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw || !raw.startsWith("--")) continue;
    const key = raw.slice(2).trim();
    if (!key) continue;

    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      parsed[key] = next;
      index += 1;
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

function resolveNonNegativeIntArg(args, names, fallback, { label } = {}) {
  for (const name of names) {
    if (args[name] === undefined) continue;
    const parsed = parseNonNegativeInt(args[name]);
    if (parsed === null) throw new Error(`Invalid ${label || name}: ${String(args[name])}`);
    return parsed;
  }
  return fallback;
}

function resolvePositiveIntArg(args, names, fallback, { label } = {}) {
  for (const name of names) {
    if (args[name] === undefined) continue;
    const parsed = parsePositiveInt(args[name]);
    if (parsed === null) throw new Error(`Invalid ${label || name}: ${String(args[name])}`);
    return parsed;
  }
  return fallback;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasProxyEnv() {
  return Boolean(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY);
}

function hasUseEnvProxyFlag() {
  return process.execArgv.includes("--use-env-proxy");
}

function warnIfProxyFlagMissing() {
  if (!hasProxyEnv() || hasUseEnvProxyFlag()) return;
  process.stderr.write(
    "warning: proxy env vars are set, but Node was not started with --use-env-proxy. " +
      "Use `pnpm regenerate-chat-rag -- ...` or `node --use-env-proxy regenerateChatRag.js ...`.\n"
  );
}

function isQuotaOrRateLimitError(error) {
  const status = Number(error?.status);
  if (status === 429) return true;

  const message = String(error?.message || "");
  return /quota|rate limit|resource exhausted/i.test(message);
}

function isTransientNetworkError(error) {
  if (error?.retryable === true) return true;

  const code = String(error?.code || error?.cause?.code || "").trim();
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }

  const message = String(error?.message || "");
  return /fetch failed|network|timeout|socket|connection/i.test(message);
}

function isRetryableIndexingError(error) {
  return isQuotaOrRateLimitError(error) || isTransientNetworkError(error);
}

async function indexChatTurnWithQuotaRetry(options, { retryMax, retryDelayMs } = {}) {
  let attempt = 0;

  for (;;) {
    try {
      return await indexChatTurn(options);
    } catch (error) {
      if (!isRetryableIndexingError(error) || attempt >= retryMax) throw error;

      attempt += 1;
      process.stdout.write(
        `\nretryable indexing error: ${error?.message || String(error)}; waiting ${retryDelayMs}ms before retry ${attempt}/${retryMax}\n`,
      );
      await sleep(retryDelayMs);
    }
  }
}

function printUsage() {
  console.log(
    `
Usage:
  pnpm regenerate-chat-rag -- --user <userId> --preset <presetId> [--limit <turns>] [--clear] [--dry-run] [--delay-ms <ms>] [--quota-retry-max <n>] [--quota-retry-delay-ms <ms>] [--concurrency <n>]
  node --use-env-proxy regenerateChatRag.js --user <userId> --preset <presetId> [--limit <turns>] [--clear] [--dry-run] [--delay-ms <ms>] [--quota-retry-max <n>] [--quota-retry-delay-ms <ms>] [--concurrency <n>]

  Without --clear, already-indexed turns are skipped (resume after interruption).
  Use --clear to wipe all chunks for this user/preset and rewrite from scratch.
  --concurrency N (default 4): how many embedding turns run in parallel.

Examples:
  pnpm regenerate-chat-rag -- --user 1 --preset default --clear
  pnpm regenerate-chat-rag -- --user 1 --preset lina --limit 200
  pnpm regenerate-chat-rag -- --user 1 --preset default --quota-retry-delay-ms 60000 --clear
`.trim(),
  );
}

async function listPresetMessages({ userId, presetId } = {}) {
  const query = `
    SELECT m.id, m.session_id, m.preset_id, m.role, m.content, m.created_at
    FROM chat_messages m
    INNER JOIN chat_sessions s ON s.id = m.session_id
    WHERE m.user_id = $1
      AND m.preset_id = $2
      AND s.user_id = $1
      AND s.deleted_at IS NULL
    ORDER BY m.id ASC
  `;
  const { rows } = await db.query(query, [userId, presetId]);
  return rows;
}

function buildTurns(messages, { limit } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const turns = [];
  let pendingUser = null;

  for (const row of rows) {
    const role = String(row?.role || "").trim();
    const content = String(row?.content || "").trim();
    if (!role || !content) continue;

    if (role === "user") {
      pendingUser = row;
      continue;
    }

    if (role !== "assistant" || !pendingUser) continue;
    if (String(row.session_id) !== String(pendingUser.session_id)) {
      pendingUser = null;
      continue;
    }

    turns.push({ userMessage: pendingUser, assistantMessage: row });
    pendingUser = null;

    if (Number.isFinite(limit) && turns.length >= limit) break;
  }

  return turns;
}

(async () => {
  warnIfProxyFlagMissing();

  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const userId = parsePositiveInt(args.user || args.userId);
  const presetId = String(args.preset || args.presetId || "").trim();
  const limit = parsePositiveInt(args.limit);
  const clear = Boolean(args.clear);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const turnDelayMs = resolveNonNegativeIntArg(args, ["delay-ms", "delayMs"], chatRagConfig.regenerateTurnDelayMs, {
    label: "delay-ms",
  });
  const quotaRetryMax = resolveNonNegativeIntArg(
    args,
    ["quota-retry-max", "quotaRetryMax"],
    chatRagConfig.regenerateQuotaRetryMax,
    { label: "quota-retry-max" },
  );
  const quotaRetryDelayMs = resolveNonNegativeIntArg(
    args,
    ["quota-retry-delay-ms", "quotaRetryDelayMs"],
    chatRagConfig.regenerateQuotaRetryDelayMs,
    { label: "quota-retry-delay-ms" },
  );
  const concurrency = resolvePositiveIntArg(args, ["concurrency", "c"], 4, { label: "concurrency" });

  if (!userId || !presetId) {
    printUsage();
    process.exit(1);
  }

  if (!chatRagConfig.enabled) {
    throw new Error("CHAT_RAG_ENABLED must be true before regenerating chat RAG chunks");
  }
  if (memoryV2Config.enabled) {
    throw new Error("regenerateChatRag.js is disabled while Memory v2 manages RAG projections; use the Memory v2 data migration command");
  }

  try {
    const messages = await listPresetMessages({ userId, presetId });
    const turns = buildTurns(messages, { limit });

    console.log("chat RAG regenerate plan:", {
      userId,
      presetId,
      messages: messages.length,
      turns: turns.length,
      clear,
      dryRun,
      turnDelayMs,
      quotaRetryMax,
      quotaRetryDelayMs,
      concurrency,
    });

    if (dryRun) return;

    if (clear) {
      const result = await deleteChunksFromMessageId({ userId, presetId, fromMessageId: 1 });
      console.log("cleared:", result);
    }

    const existingTurnKeys = clear ? new Set() : await listExistingTurnKeys({ userId, presetId });

    const turnsToIndex = turns.filter((turn) => {
      const turnKey = `${Number(turn.userMessage.id)}-${Number(turn.assistantMessage.id)}`;
      return !existingTurnKeys.has(turnKey);
    });

    const skippedTurns = turns.length - turnsToIndex.length;
    let nextIdx = 0;
    let indexedChunks = 0;
    let finishedCount = 0;
    let failedCount = 0;
    let firstError = null;

    function printProgress() {
      process.stdout.write(
        `\rprogress: ${finishedCount + skippedTurns}/${turns.length} turns, ${indexedChunks} chunks, skipped ${skippedTurns}, failed ${failedCount}`,
      );
    }

    async function runWorker() {
      while (!firstError) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= turnsToIndex.length) return;

        const turn = turnsToIndex[idx];
        if (!turn) return;

        try {
          const result = await indexChatTurnWithQuotaRetry(
            {
              userId,
              presetId,
              sessionId: turn.userMessage.session_id,
              userMessage: turn.userMessage,
              assistantMessage: turn.assistantMessage,
              userContent: turn.userMessage.content,
              assistantContent: turn.assistantMessage.content,
            },
            {
              retryMax: quotaRetryMax,
              retryDelayMs: quotaRetryDelayMs,
            },
          );
          indexedChunks += Number(result?.indexed) || 0;
        } catch (error) {
          failedCount += 1;
          if (!firstError) firstError = error;
          return;
        }

        finishedCount += 1;
        printProgress();
        if (turnDelayMs > 0) await sleep(turnDelayMs);
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(runWorker());
    }
    await Promise.all(workers);

    process.stdout.write("\n");
    console.log("done:", {
      indexedChunks,
      turns: turns.length,
      skippedTurns,
      failedTurns: failedCount,
    });

    if (firstError) {
      throw firstError;
    }
  } finally {
    await db.end();
  }
})().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
