"use strict";

const fs = require("fs");
const path = require("path");

// T15: Add MMR (Maximal Marginal Relevance) diversity config keys.
//   CHAT_RAG_MMR_LAMBDA            — blend factor [0,1] between relevance and diversity.
//   CHAT_RAG_MMR_CANDIDATE_MULTIPLIER — how many candidates to fetch before MMR selection (>=1).
// Both are required envs (fail-fast per AGENTS.md), only validated when CHAT_RAG_ENABLED=true.

const envExamplePath = path.resolve(__dirname, "..", "..", ".env.example");
const envExample = fs.readFileSync(envExamplePath, "utf8");

const configPath = path.resolve(__dirname, "..", "..", "config", "index.js");
const configSource = fs.readFileSync(configPath, "utf8");

function readEnvTemplateValue(text, key) {
  const lines = text.split(/\r?\n/);
  const prefix = key + "=";
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  return null;
}

const expectedEnv = {
  CHAT_RAG_MMR_LAMBDA: "0.7",
  CHAT_RAG_MMR_CANDIDATE_MULTIPLIER: "3",
};

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}

// ---- .env.example assertions ----
for (const key of Object.keys(expectedEnv)) {
  const actual = readEnvTemplateValue(envExample, key);
  assert(
    actual !== null,
    `.env.example: ${key} line must exist`
  );
  assert(
    actual === expectedEnv[key],
    `.env.example: ${key} must be ${expectedEnv[key]} (got ${actual})`
  );
}

// MUST NOT DO: candidate multiplier must not be < 1.
const candidateMult = readEnvTemplateValue(envExample, "CHAT_RAG_MMR_CANDIDATE_MULTIPLIER");
if (candidateMult !== null) {
  const asNum = Number(candidateMult);
  assert(
    Number.isInteger(asNum) && asNum >= 1,
    `.env.example: CHAT_RAG_MMR_CANDIDATE_MULTIPLIER must be an integer >= 1 (got ${candidateMult})`
  );
}

// MUST NOT DO: T1/T3/T5 edits must survive — spot-check untouched params.
const mustNotChange = {
  CHAT_RAG_TOP_K: "3",
  CHAT_RAG_MAX_CONTEXT_CHARS: "1800",
  CHAT_RAG_DEBUG_INCLUDE_CONTENT: "false",
  CHAT_RAG_REGENERATE_TURN_DELAY_MS: "0",
};
for (const key of Object.keys(mustNotChange)) {
  const actual = readEnvTemplateValue(envExample, key);
  assert(
    actual === mustNotChange[key],
    `.env.example: ${key} must stay ${mustNotChange[key]} (got ${actual}) — T15 MUST NOT change this`
  );
}

// ---- config/index.js assertions ----
assert(
  configSource.includes("CHAT_RAG_MMR_LAMBDA"),
  "config/index.js: must reference CHAT_RAG_MMR_LAMBDA"
);
assert(
  configSource.includes("CHAT_RAG_MMR_CANDIDATE_MULTIPLIER"),
  "config/index.js: must reference CHAT_RAG_MMR_CANDIDATE_MULTIPLIER"
);
assert(
  configSource.includes("mmrLambda"),
  "config/index.js: must declare/return mmrLambda"
);
assert(
  configSource.includes("mmrCandidateMultiplier"),
  "config/index.js: must declare/return mmrCandidateMultiplier"
);

// MUST NOT DO: envs must be REQUIRED (fail-fast), not optional.
// readRequiredFloatEnv for LAMBDA, readRequiredIntEnv for CANDIDATE_MULTIPLIER.
assert(
  /readRequiredFloatEnv\(\s*["']CHAT_RAG_MMR_LAMBDA["']\s*\)/.test(configSource),
  "config/index.js: CHAT_RAG_MMR_LAMBDA must use readRequiredFloatEnv (not optional)"
);
assert(
  /readRequiredIntEnv\(\s*["']CHAT_RAG_MMR_CANDIDATE_MULTIPLIER["']\s*\)/.test(configSource),
  "config/index.js: CHAT_RAG_MMR_CANDIDATE_MULTIPLIER must use readRequiredIntEnv (not optional)"
);
// LAMBDA validated via ensureNumberInRange with min 0 max 1.
assert(
  /ensureNumberInRange\(\s*readRequiredFloatEnv\(\s*["']CHAT_RAG_MMR_LAMBDA["']\s*\)/.test(configSource),
  "config/index.js: CHAT_RAG_MMR_LAMBDA must be wrapped in ensureNumberInRange (0..1)"
);
// CANDIDATE_MULTIPLIER validated via ensurePositiveInt (>= 1).
assert(
  /ensurePositiveInt\(\s*readRequiredIntEnv\(\s*["']CHAT_RAG_MMR_CANDIDATE_MULTIPLIER["']\s*\)/.test(configSource),
  "config/index.js: CHAT_RAG_MMR_CANDIDATE_MULTIPLIER must be wrapped in ensurePositiveInt (>=1)"
);

// ---- report ----
if (failures.length > 0) {
  console.error("mmr-config.verify FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("mmr-config.verify OK: MMR config keys present (required-env, lambda in [0,1], multiplier >= 1)");
process.exit(0);
