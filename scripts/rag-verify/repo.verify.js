/**
 * T10 verify: upsertChunk persists embedding_text; searchSimilarChunks keeps
 * the inclusive `last_message_id <= $3` scope filter (T2).
 *
 * Reads repository.js as TEXT only — no DB, no imports of app code.
 * Exits 0 on success, non-zero on assertion failure.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const repoPath = path.join(__dirname, "..", "..", "services", "chat", "rag", "repo.js");
const source = fs.readFileSync(repoPath, "utf8");

function extractFnBody(name) {
  const re = new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}\\n`);
  const m = source.match(re);
  assert.ok(m, `${name} function found`);
  return m[0];
}

const upsert = extractFnBody("upsertChunk");
const search = extractFnBody("searchSimilarChunks");

// ---- BASELINE (passes on current code) ----
assert.match(upsert, /\bcontent\b/, "baseline: upsertChunk references content");
assert.match(upsert, /\bembedding\b/, "baseline: upsertChunk references embedding");

// ---- NEW: embedding_text persisted in upsertChunk ----
assert.match(upsert, /embedding_text/, "NEW: embedding_text column referenced in upsert");
assert.match(upsert, /embeddingText[,}]/, "NEW: embeddingText in destructured params");
assert.match(upsert, /normalizedEmbeddingText/, "NEW: normalizedEmbeddingText computed");
assert.match(
  upsert,
  /embedding_text = EXCLUDED\.embedding_text/,
  "NEW: ON CONFLICT DO UPDATE sets embedding_text = EXCLUDED.embedding_text",
);
assert.match(
  upsert,
  /if \(!normalizedEmbeddingText\) throw new Error\("embeddingText is required"\);/,
  "NEW: embeddingText required validation",
);

// ---- INSERT column list / VALUES placeholders / params array consistency ----
const insertMatch = upsert.match(
  /INSERT INTO chat_rag_chunks \(\s*([\s\S]*?)\s*\)\s*VALUES \(\s*([\s\S]*?)\s*\)\s*ON CONFLICT/,
);
assert.ok(insertMatch, "INSERT ... VALUES ... ON CONFLICT block parsed");
const cols = insertMatch[1]
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const placeholders = insertMatch[2].match(/\$\d+(?:::vector)?/g) || [];
assert.ok(
  cols.includes("embedding_text"),
  "NEW: embedding_text present in INSERT column list",
);
assert.strictEqual(
  cols.length,
  placeholders.length,
  `column count (${cols.length}) must equal placeholder count (${placeholders.length})`,
);

const paramsMatch = upsert.match(/const params = \[([\s\S]*?)\];/);
assert.ok(paramsMatch, "params array parsed");
const paramsItems = paramsMatch[1]
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/,$/, ""));
assert.strictEqual(
  paramsItems.length,
  placeholders.length,
  `params array length (${paramsItems.length}) must equal placeholder count (${placeholders.length})`,
);
assert.ok(
  paramsItems.includes("normalizedEmbeddingText"),
  "NEW: normalizedEmbeddingText present in params array",
);

// ---- searchSimilarChunks preserves T2 inclusive scope filter ----
assert.match(
  search,
  /last_message_id <= \$3/,
  "T2 preserved: searchSimilarChunks WHERE includes last_message_id <= $3",
);
// embedding_text must NOT leak into retrieval side (T13 owns that)
assert.doesNotMatch(
  search,
  /embedding_text/,
  "embedding_text must NOT appear in searchSimilarChunks SELECT",
);

// ---- T13: return candidate embeddings + candidateLimit for MMR pool ----
// signature must accept candidateLimit
assert.match(
  search,
  /async function searchSimilarChunks\(\{[^}]*candidateLimit[^}]*\}/,
  "T13: searchSimilarChunks signature includes candidateLimit",
);
// SELECT list must include the embedding column
assert.match(
  search,
  /SELECT\s+id,\s+session_id,\s+first_message_id,\s+last_message_id,\s+chunk_index,\s+source_kind,\s+source_hash,\s+content,\s+embedding,\s+metadata,/i,
  "T13: SELECT lists embedding after content",
);
// normalizedCandidateLimit validation branch present
assert.match(
  search,
  /const normalizedCandidateLimit = candidateLimit != null\s+\?\s+normalizePositiveInteger\(candidateLimit, \{ name: "candidateLimit" \}\)\s+:\s+normalizedLimit;/,
  "T13: candidateLimit normalized with fallback to limit",
);
// returned row mapping must surface the embedding field after content
assert.match(
  search,
  /content: row\.content,\s+embedding: row\.embedding,/i,
  "T13: rows.map includes embedding: row.embedding after content",
);
// LIMIT $9 must now be backed by normalizedCandidateLimit in the params array,
// not normalizedLimit (i.e. normalizedLimit must NOT be the LIMIT param value)
assert.doesNotMatch(
  search,
  /normalizedMinSimilarity,\s+normalizedLimit,\s+\]/,
  "T13: normalizedLimit removed from LIMIT slot in params array",
);
assert.match(
  search,
  /normalizedMinSimilarity,\s+normalizedCandidateLimit,\s+\]/,
  "T13: normalizedCandidateLimit placed in LIMIT slot of params array",
);

console.log("repo.verify.js: ALL PASS");