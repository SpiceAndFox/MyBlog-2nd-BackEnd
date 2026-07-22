const { createCommandContext } = require("../app/composition/commandContext");
const { database: db, config, logger } = createCommandContext();
const memoryRuntime = require("../services/chat/memoryRuntime");
memoryRuntime.configureChatMemoryRuntime(memoryRuntime.createChatMemoryRuntime({
  config: config.memoryV2Config,
  logger,
}));

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  const userId = Number(values.userId);
  const presetId = String(values.presetId ?? "").trim();
  const targetKey = String(values.targetKey ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId || !targetKey) {
    throw new Error("Usage: npm run resume:memory-v2 -- --userId <id> --presetId <id> --targetKey <key>");
  }
  return { userId, presetId, targetKey };
}

async function main() {
  if (!memoryRuntime.enabled) throw new Error("Memory v2 is disabled");
  const args = readArgs(process.argv.slice(2));
  const result = await memoryRuntime.resumeTarget(args.userId, args.presetId, args.targetKey);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().then(() => db.end()).catch(async (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  try { await db.end(); } catch {}
  process.exitCode = 1;
});
