const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPORT_FORMAT_VERSION = 3;

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sanitizeConfig(value, key = "") {
  if (/api.?key|authorization|password|secret|token$/i.test(key)) {
    return { configured: Boolean(String(value ?? "").trim()) };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeConfig(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    sanitizeConfig(entryValue, entryKey),
  ]));
}

function gitValue(rootDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 100 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function buildWorkingTreeStateHash(rootDir) {
  const diff = gitValue(rootDir, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const untracked = gitValue(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || untracked === null) return null;
  const hash = crypto.createHash("sha256").update(diff);
  for (const relativePath of untracked.split("\0").filter(Boolean).sort()) {
    hash.update("\0").update(relativePath).update("\0");
    hash.update(fs.readFileSync(path.join(rootDir, relativePath)));
  }
  return `sha256:${hash.digest("hex")}`;
}

function buildCodeFingerprint(rootDir) {
  const commit = gitValue(rootDir, ["rev-parse", "HEAD"]);
  const tree = gitValue(rootDir, ["rev-parse", "HEAD^{tree}"]);
  const status = gitValue(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    gitCommit: commit,
    gitTree: tree,
    workingTreeDirty: status === null ? null : status.length > 0,
    workingTreeStateHash: status === null ? null : buildWorkingTreeStateHash(rootDir),
  };
}

function buildSchemaFingerprint(rootDir) {
  const migrationsDir = path.join(rootDir, "migrations/memory");
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const content = fs.readFileSync(path.join(migrationsDir, name));
      return { name, sha256: sha256(content) };
    });
  return { sha256: sha256(stableJson(files)), files };
}

function buildMigrationEvidence({ rootDir, memoryConfig, ragConfig = null } = {}) {
  const sanitizedConfig = sanitizeConfig({ memory: memoryConfig, rag: ragConfig });
  return {
    reportFormatVersion: REPORT_FORMAT_VERSION,
    code: buildCodeFingerprint(rootDir),
    schema: buildSchemaFingerprint(rootDir),
    config: {
      sha256: sha256(stableJson(sanitizedConfig)),
      values: sanitizedConfig,
    },
  };
}

module.exports = {
  REPORT_FORMAT_VERSION,
  buildMigrationEvidence,
  buildCodeFingerprint,
  buildSchemaFingerprint,
  sanitizeConfig,
  sha256,
  stableJson,
};
