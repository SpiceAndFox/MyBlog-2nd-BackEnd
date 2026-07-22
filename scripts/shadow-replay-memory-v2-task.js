#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

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
    if (!["taskId", "model", "report"].includes(key)) throw new Error(`Unknown argument: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

function resolveOptions(values) {
  if (values.help) return { help: true };
  const taskId = String(values.taskId ?? "").trim();
  const model = values.model === undefined ? null : String(values.model).trim();
  const report = values.report === undefined ? null : path.resolve(String(values.report).trim());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw new Error("--taskId must be a UUID");
  }
  if (values.model !== undefined && !model) throw new Error("--model cannot be empty");
  if (values.report !== undefined && !String(values.report).trim()) throw new Error("--report cannot be empty");
  return { help: false, taskId, model, report };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run shadow:memory-v2 -- --taskId <uuid> [--model <model>] [--report <new-file.json>]",
    "",
    "Replays one persisted task_payload with the current prompt and output schema, then runs local schema validation and Reducer preflight.",
    "This command invokes the configured provider but does not write Memory state, cursor, events, or tasks.",
    "--model overrides only the provider model for an explicit A/B run. --report refuses to overwrite an existing file.",
    "",
  ].join("\n"));
}

function createReplay(modelOverride = null) {
  const memory = require("../modules/memory");
  const loaded = memory.loadMemoryV2Config(process.env);
  if (!loaded.enabled) throw new Error("Memory v2 is disabled");
  const config = modelOverride
    ? { ...loaded, provider: { ...loaded.provider, model: modelOverride } }
    : loaded;
  return memory.createDefaultMemoryTaskShadowReplay({ config });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const replay = dependencies.replay || createReplay(options.model);
  const report = await replay.replay(options.taskId);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) await fs.writeFile(options.report, json, { encoding: "utf8", flag: "wx" });
  process.stdout.write(json);
  return report;
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const db = require("../db");
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await db.end();
  });
}

module.exports = { parseArgs, resolveOptions, printUsage, createReplay, main };
