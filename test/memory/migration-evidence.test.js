const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  REPORT_FORMAT_VERSION,
  buildMigrationEvidence,
  sanitizeConfig,
  stableJson,
} = require("../../modules/memory/application/migrationEvidence");

test("migration evidence fingerprints code, every schema migration, and redacted configuration", () => {
  const rootDir = path.join(__dirname, "../..");
  const evidence = buildMigrationEvidence({
    rootDir,
    memoryConfig: {
      enabled: true,
      provider: { model: "deepseek-v4-flash", apiKey: "memory-secret" },
    },
    ragConfig: {
      embeddingModel: "Qwen/Qwen3-Embedding-8B",
      embeddingApiKey: "embedding-secret",
      rerankerModel: "Qwen/Qwen3-Reranker-8B",
    },
  });

  assert.equal(evidence.reportFormatVersion, REPORT_FORMAT_VERSION);
  assert.equal(evidence.reportFormatVersion, 3);
  assert.match(evidence.code.gitCommit, /^[a-f0-9]{40}$/);
  assert.match(evidence.schema.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.schema.files.some((file) => file.name === "009-launch-gate-legacy-projections.sql"), true);
  assert.match(evidence.config.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.config.values.memory.provider.model, "deepseek-v4-flash");
  assert.deepEqual(evidence.config.values.memory.provider.apiKey, { configured: true });
  assert.deepEqual(evidence.config.values.rag.embeddingApiKey, { configured: true });
  assert.doesNotMatch(JSON.stringify(evidence), /memory-secret|embedding-secret/);
});

test("configuration fingerprints are stable across property insertion order", () => {
  const left = sanitizeConfig({ b: 2, a: { apiKey: "one", model: "m" } });
  const right = sanitizeConfig({ a: { model: "m", apiKey: "two" }, b: 2 });
  assert.equal(stableJson(left), stableJson(right));
});
