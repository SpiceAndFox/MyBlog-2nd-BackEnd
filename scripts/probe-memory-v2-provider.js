const dotenv = require("dotenv");
dotenv.config();
const { loadMemoryProviderConfig, createStructuredTransport, runStructuredOutputPreflight, loadProposerPrompt } = require("../modules/memory");

async function main() {
  const config = loadMemoryProviderConfig(process.env);
  const invokeStructured = createStructuredTransport(config);
  const probes = await runStructuredOutputPreflight({ invokeStructured, promptLoader: loadProposerPrompt });
  process.stdout.write(`${JSON.stringify({ status: "supported", adapter: config.adapter, model: config.model, probes })}\n`);
}

main().catch((error) => {
  const cause = error?.cause?.code || error?.cause?.message;
  process.stderr.write(`${error.message}${cause ? ` (${cause})` : ""}\n`);
  process.exitCode = 1;
});
