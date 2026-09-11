if (require.main === module) require("dotenv").config();
const { loadMemoryProviderConfig, createStructuredTransport, runStructuredOutputPreflight, loadProposerPrompt } = require("../modules/memory/admin");

function parseArgs(argv) {
  if (argv.some(arg => arg !== "--todo-only")) {
    throw new Error("Usage: node scripts/probe-memory-v2-provider.js [--todo-only]");
  }
  return { todoOnly: argv.includes("--todo-only") };
}

async function main(argv = process.argv.slice(2)) {
  const { todoOnly } = parseArgs(argv);
  const config = loadMemoryProviderConfig(process.env);
  const invokeStructured = createStructuredTransport(config);
  const probes = await runStructuredOutputPreflight({
    invokeStructured,
    promptLoader: loadProposerPrompt,
    todoOnly,
  });
  process.stdout.write(`${JSON.stringify({
    status: "supported",
    adapter: config.adapter,
    profile: config.profile,
    policy: config.policy,
    modelRules: config.modelRules,
    defaultModel: config.model,
    proposerModels: config.proposerModels,
    probes,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const cause = error?.cause?.code || error?.cause?.message;
    const detail = error?.detail ? ` ${JSON.stringify(error.detail)}` : "";
    process.stderr.write(`${error.message}${cause ? ` (${cause})` : ""}${detail}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main };
