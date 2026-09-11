#!/usr/bin/env node
const { logWait, createCommandControl } = require("./memory-command-control");
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--") || argv[index + 1] === undefined || String(argv[index + 1]).startsWith("--")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (!["userId", "presetId", "mode"].includes(key)) throw new Error(`Unknown argument: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

function resolveOptions(values) {
  if (values.help) return { help: true };
  const userId = Number(values.userId);
  const presetId = String(values.presetId ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) {
    throw new Error("--userId must be a positive integer and --presetId cannot be empty");
  }
  const mode = String(values.mode ?? "resume").trim();
  if (!["fresh", "resume"].includes(mode)) throw new Error("--mode must be fresh or resume");
  return { help: false, userId, presetId, mode };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run rebuild:memory-v2 -- --userId <id> --presetId <id> [--mode fresh|resume]",
    "",
    "Rebuilds only the selected Memory v2 scope, waits for all targets and its RAG projection, then verifies the result.",
    "This command writes Memory authority/projection data and invokes the configured Memory provider.",
    "",
    "--mode resume（默认）在存在可恢复的 generation 时接着上次进度，否则回退为从头开始。",
    "--mode fresh 强制开启新 generation，从头处理全部消息。",
    "",
  ].join("\n"));
}

function createScopedMigration({ database, config, logger, chatLlm, chatRagProjectionAdapter } = {}) {
  const { createMemoryAdministrationComposition } = require("../app/composition/memory");
  const administration = createMemoryAdministrationComposition({ database });
  const memoryConfig = config?.memoryV2Config;
  if (!memoryConfig?.enabled) throw new Error("Memory v2 is disabled");
  const projectionAdapter = chatRagProjectionAdapter || require("../app/composition/chatRag")
    .createChatRagComposition({ config, database, logger, llm: chatLlm }).projectionAdapter;
  return administration.createMigration({
    config: memoryConfig,
    projectionDrains: {
      rag: administration.createProjectionDrain("rag", projectionAdapter),
    },
  });
}

async function rebuildScope({ db, migration, userId, presetId, mode = "resume", ...executionOptions }) {
  const { rows } = await db.query(`
    SELECT 1
    FROM chat_prompt_presets
    WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NULL
  `, [userId, presetId]);
  if (!rows[0]) throw new Error(`Active preset not found: userId=${userId}, presetId=${presetId}`);

  const scope = { userId, presetId };
  const inventory = await migration.inventory([scope]);
  if (inventory.length !== 1) throw new Error(`Memory scope inventory failed: userId=${userId}, presetId=${presetId}`);
  const result = await migration.rebuildScope(scope, inventory[0], { forceNewGeneration: mode !== "resume", ...executionOptions });
  return { status: "completed", ...result };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const context = dependencies.context || (!dependencies.migration
    ? require("../app/composition/commandContext").createCommandContext()
    : null);
  const db = dependencies.db || context?.database;
  const migration = dependencies.migration || createScopedMigration({
    database: db,
    config: context.config,
    logger: context.logger,
    chatLlm: context.chatLlm,
  });
  const { help: _help, ...scopeOptions } = options;
  const result = await rebuildScope({ db, migration, ...scopeOptions, signal: dependencies.signal, onWait: dependencies.onWait || logWait });
  if (!dependencies.signal?.aborted) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  const control = createCommandControl({ name: "rebuild:memory-v2" });
  let context;
  control.run(async () => {
    context = require("../app/composition/commandContext").createCommandContext();
    return main(process.argv.slice(2), { context, ...control });
  }, async () => { await context?.database.end(); });
}

module.exports = { parseArgs, resolveOptions, printUsage, createScopedMigration, rebuildScope, main };
