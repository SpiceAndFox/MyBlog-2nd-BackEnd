const dotenv = require("dotenv");
dotenv.config();
const { loadMemoryProviderConfig } = require("../modules/memory/config/loadProviderConfig");
const { createStructuredTransport } = require("../modules/memory/infrastructure/providers/structuredTransportFactory");

async function main() {
  const config = loadMemoryProviderConfig(process.env);
  if (config.model !== "deepseek-v4-flash") throw new Error("Stage 8 provider probe is restricted to deepseek-v4-flash");
  const invokeStructured = createStructuredTransport(config);
  const result = await invokeStructured({
    systemPrompt: "Return the result through the required schema-constrained output channel.",
    userPayload: { instruction: "Return ok=true." },
    responseSchema: {
      name: "memory_v2_stage8_probe",
      strict: true,
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
  });
  if (result?.output?.ok !== true) throw new Error("Provider returned an invalid schema-constrained probe result");
  process.stdout.write(`${JSON.stringify({ status: "supported", adapter: config.adapter, model: result.model || config.model, finishReason: result.finishReason || null })}\n`);
}

main().catch((error) => {
  const cause = error?.cause?.code || error?.cause?.message;
  process.stderr.write(`${error.message}${cause ? ` (${cause})` : ""}\n`);
  process.exitCode = 1;
});
