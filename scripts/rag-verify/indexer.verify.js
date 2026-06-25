"use strict";

const fs = require("fs");
const path = require("path");

const indexerPath = path.resolve(__dirname, "..", "..", "services", "chat", "rag", "indexer.js");
const source = fs.readFileSync(indexerPath, "utf8");

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(
  source.includes("await createEmbeddings({ texts: chunks.map((chunk) =>"),
  "indexer must keep batched createEmbeddings over chunks"
);
assert(
  source.includes("buildDocumentEmbeddingText(chunk.embeddingText)"),
  "indexer must embed chunk.embeddingText, not display content"
);
assert(
  !source.includes("buildDocumentEmbeddingText(chunk.content)"),
  "indexer must not embed chunk.content"
);
assert(
  source.includes("embedding: embeddings[index]"),
  "indexer must preserve per-chunk embedding alignment"
);

const upsertBlockMatch = source.match(/upsertChunk\(\{[\s\S]*?\}\);/);
assert(!!upsertBlockMatch, "indexer must contain a chatRagRepo.upsertChunk block");

if (upsertBlockMatch) {
  const block = upsertBlockMatch[0];
  assert(block.includes("content: chunk.content,"), "upsertChunk must persist display content");
  assert(block.includes("embeddingText: chunk.embeddingText,"), "upsertChunk must persist embeddingText");
  assert(
    block.indexOf("embeddingText: chunk.embeddingText,") > block.indexOf("content: chunk.content,"),
    "embeddingText should be passed after content for readability"
  );
  assert(block.includes("embedding: embeddings[index],"), "upsertChunk must keep embedding batch alignment");
}

if (failures.length > 0) {
  console.error("indexer.verify FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}

console.log("indexer.verify OK: embeds semantic embeddingText and persists it");
