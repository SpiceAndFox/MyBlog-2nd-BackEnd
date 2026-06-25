"use strict";

const fs = require("fs");
const path = require("path");

const envExamplePath = path.resolve(__dirname, "..", "..", ".env.example");
const envExample = fs.readFileSync(envExamplePath, "utf8");

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

const queryEmbeddingTemplate = readEnvTemplateValue(
  envExample,
  "CHAT_RAG_QUERY_EMBEDDING_TEMPLATE"
);
const documentEmbeddingTemplate = readEnvTemplateValue(
  envExample,
  "CHAT_RAG_DOCUMENT_EMBEDDING_TEMPLATE"
);

// ---- BASELINE diagnostics (informational; prove we are reading the right lines) ----
const baseline = [];
baseline.push({
  label: "query template still has `task: search result |` prefix (BUG)",
  present:
    queryEmbeddingTemplate !== null &&
    queryEmbeddingTemplate.includes("search result"),
});
baseline.push({
  label: "document template still has `title: historical companion chat |` prefix (BUG)",
  present:
    documentEmbeddingTemplate !== null &&
    documentEmbeddingTemplate.includes("title: historical companion chat"),
});

console.log("embedding-templates.verify — BASELINE diagnostics (informational):");
for (const b of baseline) {
  console.log(`  [${b.present ? "PRESENT" : "ABSENT"}] ${b.label}`);
}

// ---- NEW assertions: the gate. Fail on current code, pass after the fix. ----
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(
  queryEmbeddingTemplate !== null,
  ".env.example: CHAT_RAG_QUERY_EMBEDDING_TEMPLATE line must exist"
);
assert(
  queryEmbeddingTemplate !== null && queryEmbeddingTemplate.includes("{{query}}"),
  "CHAT_RAG_QUERY_EMBEDDING_TEMPLATE must contain the `{{query}}` token (used by retriever.js buildQueryEmbeddingText)"
);
assert(
  queryEmbeddingTemplate === null || !queryEmbeddingTemplate.includes("search result"),
  "CHAT_RAG_QUERY_EMBEDDING_TEMPLATE must NOT contain `search result` (task label was backwards: query is a search input, not a search result)"
);

assert(
  documentEmbeddingTemplate !== null,
  ".env.example: CHAT_RAG_DOCUMENT_EMBEDDING_TEMPLATE line must exist"
);
assert(
  documentEmbeddingTemplate !== null && documentEmbeddingTemplate.includes("{{content}}"),
  "CHAT_RAG_DOCUMENT_EMBEDDING_TEMPLATE must contain the `{{content}}` token (used by chunker.js buildDocumentEmbeddingText)"
);
assert(
  documentEmbeddingTemplate === null ||
    !documentEmbeddingTemplate.includes("title: historical companion chat"),
  "CHAT_RAG_DOCUMENT_EMBEDDING_TEMPLATE must NOT contain `title: historical companion chat` (identical title on every chunk gives no discriminative signal to embeddings)"
);

if (failures.length > 0) {
  console.error("embedding-templates.verify FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("embedding-templates.verify OK: embedding templates cleaned");
process.exit(0);
