#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "../.env"), quiet: true });

const db = require("../db");
const memory = require("../modules/memory");
const {
  createChatRagProjectionAdapter,
} = require("../services/chat/rag/projectionAdapters");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      parsed[key] = String(next);
      index += 1;
    } else parsed[key] = true;
  }
  return parsed;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function resolveOptions(args) {
  const mode = String(args.mode || "inventory").trim();
  if (!["inventory", "rehearsal", "cutover"].includes(mode)) {
    throw new Error("--mode must be inventory, rehearsal, or cutover");
  }
  const userRaw = args.user ?? args.userId;
  const presetRaw = args.preset ?? args.presetId;
  if ((userRaw === undefined) !== (presetRaw === undefined)) {
    throw new Error("--user and --preset must be provided together");
  }
  const scopes = userRaw === undefined ? undefined : [{
    userId: positiveInteger(userRaw, "--user"),
    presetId: String(presetRaw || "").trim(),
  }];
  if (scopes && !scopes[0].presetId) throw new Error("--preset cannot be empty");
  return {
    mode,
    scopes,
    apply: args.apply === true,
    serviceStopped: args["service-stopped"] === true || args.serviceStopped === true,
    reportPath: typeof args.report === "string" && args.report.trim() ? path.resolve(args.report.trim()) : null,
    pricingPath: typeof args.pricing === "string" && args.pricing.trim() ? path.resolve(args.pricing.trim()) : null,
  };
}

function printUsage() {
  process.stdout.write([
    "Usage:",
    "  npm run migrate:memory-v2-data -- --mode inventory [--user <id> --preset <id>]",
    "  npm run migrate:memory-v2-data -- --mode rehearsal --apply --report <path> [--pricing <versioned-pricing.json>] [--user <id> --preset <id>]",
    "  npm run migrate:memory-v2-data -- --mode cutover --apply --service-stopped --report <path> [--pricing <versioned-pricing.json>] [--user <id> --preset <id>]",
    "",
    "inventory is read-only. rehearsal and cutover rebuild Memory plus RAG and write authority data; query-time Recall inherits the RAG cutoff.",
    "Run rehearsal only against a production-history copy. Cutover requires the public service to be stopped.",
    "",
  ].join("\n"));
}

function withCallEstimates(inventory, config) {
  return inventory.map((scope) => ({
    ...scope,
    estimatedNormalTaskCount: Object.values(config.targets).reduce(
      (sum, target) => sum + Math.ceil(scope.messageCount / target.lagThreshold),
      0,
    ),
  }));
}

function emitReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, serialized, { encoding: "utf8", flag: "wx" });
}

function assertReportPathAvailable(reportPath) {
  if (fs.existsSync(reportPath)) throw new Error(`Report path already exists: ${reportPath}`);
}

function createMigration(config, providerTelemetry) {
  const projectionDrains = {
    rag: memory.createDefaultProjectionDrain("rag", createChatRagProjectionAdapter()),
  };
  return memory.createDefaultMemoryMigration({ config, projectionDrains, providerTelemetry });
}

function attachEvidence(report, evidence) {
  return { ...report, evidence };
}

function enforceEvidenceGate(report, evidence) {
  const withEvidence = attachEvidence(report, evidence);
  if (report.status !== "completed") return withEvidence;
  const issues = [];
  if (!evidence?.code?.gitCommit || !evidence?.code?.gitTree) issues.push("code_fingerprint_unavailable");
  if (report.mode === "cutover" && evidence?.code?.workingTreeDirty !== false) issues.push("cutover_working_tree_not_clean");
  if (!evidence?.schema?.sha256 || !evidence?.schema?.files?.length) issues.push("schema_fingerprint_unavailable");
  if (!evidence?.config?.sha256) issues.push("config_fingerprint_unavailable");
  if (!report.providerUsage?.tokenUsageCoverageComplete) issues.push("provider_token_usage_incomplete");
  if (!report.providerUsage?.costCoverageComplete) issues.push("provider_cost_coverage_incomplete");
  if (!report.providerUsage?.retryClassificationCoverageComplete) issues.push("provider_retry_classification_incomplete");
  if (!report.sourceInventory?.before?.contentFingerprintCoverageComplete
    || !report.sourceInventory?.after?.contentFingerprintCoverageComplete) issues.push("source_content_fingerprint_incomplete");
  if (!report.sourceInventory?.unchanged) issues.push("source_inventory_not_stable");
  if (!issues.length) return { ...withEvidence, evidenceGate: { status: "passed", issues: [] } };
  return {
    ...withEvidence,
    status: "evidence_incomplete",
    migrationStatus: report.status,
    canStartService: false,
    evidenceGate: { status: "failed", issues },
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help === true || args.h === true) {
    printUsage();
    return { status: "help" };
  }
  const options = resolveOptions(args);
  const config = memory.loadMemoryV2Config({ ...process.env, CHAT_MEMORY_V2_ENABLED: "true" });
  const { pricing, evidence: pricingEvidence } = memory.loadPricingFile(options.pricingPath);
  const providerTelemetry = memory.createMigrationProviderTelemetry({
    pricing,
    expectedModel: config.provider.model,
  });
  const evidence = memory.buildMigrationEvidence({
    rootDir: path.join(__dirname, ".."),
    memoryConfig: config,
    ragConfig: require("../config").chatRagConfig,
    pricingEvidence,
  });
  const migration = createMigration(config, providerTelemetry);
  const inventory = withCallEstimates(await migration.inventory(options.scopes), config);

  if (options.mode === "inventory") {
    const report = attachEvidence({ status: "inventory", scopeCount: inventory.length, scopes: inventory }, evidence);
    emitReport(report, options.reportPath);
    return report;
  }

  if (!options.apply) {
    const report = attachEvidence({
      status: "apply_required",
      mode: options.mode,
      scopeCount: inventory.length,
      scopes: inventory,
      requiredFlag: "--apply",
      requiredReportFlag: "--report <path>",
      ...(options.mode === "cutover" ? { requiredCutoverFlag: "--service-stopped" } : {}),
    }, evidence);
    emitReport(report, options.reportPath);
    return report;
  }
  if (!options.reportPath) throw new Error(`${options.mode} requires --report <path>`);
  if (options.mode === "cutover" && !options.serviceStopped) {
    throw new Error("Cutover requires --service-stopped");
  }
  assertReportPathAvailable(options.reportPath);

  const report = enforceEvidenceGate(await migration.run({
    mode: options.mode,
    serviceStopped: options.serviceStopped,
    scopes: options.scopes,
  }), evidence);
  emitReport(report, options.reportPath);
  if (report.status !== "completed") process.exitCode = 2;
  return report;
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = { parseArgs, resolveOptions, withCallEstimates, enforceEvidenceGate, emitReport, assertReportPathAvailable, attachEvidence, main };
