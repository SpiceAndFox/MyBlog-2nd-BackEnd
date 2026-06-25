"use strict";

const fs = require("fs");
const path = require("path");

const CHAT_DIR = path.resolve(__dirname, "..", "..", "services", "chat");

const contextCompilerPath = path.join(CHAT_DIR, "contextCompiler.js");
const retrieverPath = path.join(CHAT_DIR, "rag", "retriever.js");
const repoPath = path.join(CHAT_DIR, "rag", "repo.js");

const contextCompiler = fs.readFileSync(contextCompilerPath, "utf8");
const retriever = fs.readFileSync(retrieverPath, "utf8");
const repo = fs.readFileSync(repoPath, "utf8");

// ---- BASELINE diagnostics (informational; prove we are reading the right code) ----
// On current/buggy code these old strings are present. After the fix they are gone.
const baseline = [];
baseline.push({
  label: "contextCompiler uses upToMessageId for RAG beforeMessageId (BUG)",
  present: contextCompiler.includes("beforeMessageId: normalizeMessageId(upToMessageId)"),
});
baseline.push({
  label: "repo searchSimilarChunks uses exclusive < $3 filter (BUG)",
  present: repo.includes("last_message_id < $3"),
});
baseline.push({
  label: "retriever guard reason is missing_before_message_id (pre-rename)",
  present: retriever.includes("missing_before_message_id"),
});

console.log("scope-boundary.verify — BASELINE diagnostics (informational):");
for (const b of baseline) {
  console.log(`  [${b.present ? "PRESENT" : "ABSENT"}] ${b.label}`);
}

// ---- NEW assertions: the gate. Fail on current code, pass after the fix. ----
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

// contextCompiler.js: RAG beforeMessageId must reference summarizedUntilMessageId, not upToMessageId.
assert(
  contextCompiler.includes("beforeMessageId: summarizedUntilMessageId"),
  "contextCompiler.js: must pass `beforeMessageId: summarizedUntilMessageId` to retrieveChatRagContext"
);
assert(
  !contextCompiler.includes("beforeMessageId: normalizeMessageId(upToMessageId)"),
  "contextCompiler.js: must NOT pass `beforeMessageId: normalizeMessageId(upToMessageId)` (the bug)"
);

// repo.js: searchSimilarChunks filter must be inclusive <= $3, not exclusive < $3.
assert(
  repo.includes("AND last_message_id <= $3"),
  "repo.js: searchSimilarChunks must use `AND last_message_id <= $3` (inclusive summarized boundary)"
);
assert(
  !repo.includes("last_message_id < $3"),
  "repo.js: must NOT contain `last_message_id < $3` (exclusive filter was the bug)"
);

// retriever.js: guard reason must reflect summarized-history semantics.
assert(
  retriever.includes("no_summarized_history"),
  "retriever.js: guard reason must be `no_summarized_history`"
);
assert(
  !retriever.includes("missing_before_message_id"),
  "retriever.js: must NOT contain `missing_before_message_id` (pre-rename reason)"
);

// MUST NOT DO guard: deleteChunksFromMessageId must remain unchanged (>= $3).
assert(
  repo.includes("AND last_message_id >= $3"),
  "repo.js: deleteChunksFromMessageId must still use `AND last_message_id >= $3` (untouched)"
);

if (failures.length > 0) {
  console.error("scope-boundary.verify FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("scope-boundary.verify OK: scope<=summarizedUntil");
process.exit(0);
