#!/usr/bin/env node
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
    if (!["userId", "presetId"].includes(key)) throw new Error(`Unknown argument: ${argument}`);
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
  return { help: false, userId, presetId };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run rebuild:memory-v2 -- --userId <id> --presetId <id>",
    "",
    "Rebuilds only the selected Memory v2 scope, waits for all targets and its RAG projection, then verifies the result.",
    "This command writes Memory authority/projection data and invokes the configured Memory provider.",
    "",
  ].join("\n"));
}

function createScopedMigration({ database } = {}) {
  const memory = require("../modules/memory/admin");
  const { createMemoryAdministrationComposition } = require("../app/composition/memory");
  const administration = createMemoryAdministrationComposition({ database });
  const config = memory.loadMemoryV2Config(process.env);
  if (!config.enabled) throw new Error("Memory v2 is disabled");
  const { createChatRagProjectionAdapter } = require("../services/chat/rag/projectionAdapters");
  return administration.createMigration({
    config,
    projectionDrains: {
      rag: administration.createProjectionDrain("rag", createChatRagProjectionAdapter()),
    },
  });
}

async function rebuildScope({ db, migration, userId, presetId }) {
  const { rows } = await db.query(`
    SELECT 1
    FROM chat_prompt_presets
    WHERE user_id = $1 AND preset_id = $2 AND deleted_at IS NULL
  `, [userId, presetId]);
  if (!rows[0]) throw new Error(`Active preset not found: userId=${userId}, presetId=${presetId}`);

  const scope = { userId, presetId };
  const inventory = await migration.inventory([scope]);
  if (inventory.length !== 1) throw new Error(`Memory scope inventory failed: userId=${userId}, presetId=${presetId}`);
  const result = await migration.rebuildScope(scope, inventory[0], { forceNewGeneration: true });
  return { status: "completed", ...result };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const db = dependencies.db || require("../app/composition/commandContext").createCommandContext().database;
  const migration = dependencies.migration || createScopedMigration({ database: db });
  const result = await rebuildScope({ db, migration, ...options });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  let db;
  main(process.argv.slice(2), {
    get db() {
      if (!db) db = require("../app/composition/commandContext").createCommandContext().database;
      return db;
    },
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    if (db) await db.end();
  });
}

module.exports = { parseArgs, resolveOptions, printUsage, createScopedMigration, rebuildScope, main };
