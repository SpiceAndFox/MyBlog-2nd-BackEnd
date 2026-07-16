const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, resolveOptions, enforceEvidenceGate } = require("../../scripts/migrate-memory-v2-data");

test("Memory v2 data migration CLI defaults to read-only inventory", () => {
  assert.deepEqual(resolveOptions(parseArgs([])), {
    mode: "inventory",
    scopes: undefined,
    apply: false,
    serviceStopped: false,
    reportPath: null,
  });
});

test("cutover evidence gate rejects incomplete usage and a dirty tree", () => {
  const report = enforceEvidenceGate({
    status: "completed",
    mode: "cutover",
    canStartService: true,
    providerUsage: {
      tokenUsageCoverageComplete: false,
      retryClassificationCoverageComplete: true,
    },
    sourceInventory: {
      unchanged: true,
      before: { contentFingerprintCoverageComplete: true },
      after: { contentFingerprintCoverageComplete: true },
    },
  }, {
    code: { gitCommit: "a".repeat(40), gitTree: "b".repeat(40), workingTreeDirty: true },
    schema: { sha256: "sha256:schema", files: [{ name: "001.sql" }] },
    config: { sha256: "sha256:config" },
  });
  assert.equal(report.status, "evidence_incomplete");
  assert.equal(report.migrationStatus, "completed");
  assert.equal(report.canStartService, false);
  assert.deepEqual(report.evidenceGate.issues, [
    "cutover_working_tree_not_clean",
    "provider_token_usage_incomplete",
  ]);
});

test("rehearsal evidence gate passes with complete telemetry while keeping service closed", () => {
  const report = enforceEvidenceGate({
    status: "completed",
    mode: "rehearsal",
    canStartService: false,
    providerUsage: {
      tokenUsageCoverageComplete: true,
      retryClassificationCoverageComplete: true,
    },
    sourceInventory: {
      unchanged: true,
      before: { contentFingerprintCoverageComplete: true },
      after: { contentFingerprintCoverageComplete: true },
    },
  }, {
    code: { gitCommit: "a".repeat(40), gitTree: "b".repeat(40), workingTreeDirty: true },
    schema: { sha256: "sha256:schema", files: [{ name: "001.sql" }] },
    config: { sha256: "sha256:config" },
  });
  assert.equal(report.status, "completed");
  assert.equal(report.canStartService, false);
  assert.deepEqual(report.evidenceGate, { status: "passed", issues: [] });
});

test("Memory v2 data migration CLI requires explicit scope pairs and cutover confirmation", () => {
  assert.throws(() => resolveOptions(parseArgs(["--user", "1"])), /provided together/);
  assert.deepEqual(resolveOptions(parseArgs([
    "--mode", "cutover", "--user", "1", "--preset", "lina", "--apply", "--service-stopped",
    "--report", "reports/cutover.json",
  ])), {
    mode: "cutover",
    scopes: [{ userId: 1, presetId: "lina" }],
    apply: true,
    serviceStopped: true,
    reportPath: require("node:path").resolve("reports/cutover.json"),
  });
});
