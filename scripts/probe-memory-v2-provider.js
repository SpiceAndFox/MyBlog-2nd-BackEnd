const dotenv = require("dotenv");
dotenv.config();
const { loadMemoryProviderConfig, createStructuredTransport, runStructuredOutputPreflight, loadProposerPrompt } = require("../modules/memory/admin");

async function main() {
  const config = loadMemoryProviderConfig(process.env);
  const invokeStructured = createStructuredTransport(config);
  const probes = await runStructuredOutputPreflight({ invokeStructured, promptLoader: loadProposerPrompt });
  process.stdout.write(`${JSON.stringify({
    status: "supported",
    adapter: config.adapter,
    defaultModel: config.model,
    proposerModels: config.proposerModels,
    probes,
  })}\n`);
}

main().catch((error) => {
  const cause = error?.cause?.code || error?.cause?.message;
  const detail = error?.detail ? ` ${JSON.stringify(error.detail)}` : "";
  process.stderr.write(`${error.message}${cause ? ` (${cause})` : ""}${detail}\n`);
  process.exitCode = 1;
});
