const crypto = require("crypto");
const { renderTemplate } = require("./templates");

function createChatRagChunker({ config: chatRagConfig } = {}) {
  if (!chatRagConfig || typeof chatRagConfig !== "object") throw new Error("Chat RAG chunker config is required");

function normalizeContent(value) {
  return String(value || "").trim();
}

function hashContent(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildTurnText({ userContent, assistantContent } = {}) {
  const user = normalizeContent(userContent);
  const assistant = normalizeContent(assistantContent);
  if (!user) throw new Error("Missing userContent for chat RAG turn");
  if (!assistant) throw new Error("Missing assistantContent for chat RAG turn");

  return renderTemplate(chatRagConfig.turnTemplate, {
    user,
    assistant,
  }).trim();
}

function buildEmbeddingText({ userContent, assistantContent } = {}) {
  const user = normalizeContent(userContent);
  const assistant = normalizeContent(assistantContent);
  if (!user) throw new Error("Missing userContent for chat RAG turn embedding");
  if (!assistant) throw new Error("Missing assistantContent for chat RAG turn embedding");

  return [
    "用户：",
    user,
    "助手：",
    assistant,
  ].join("\n").trim();
}

function buildDocumentEmbeddingText(content) {
  const normalized = normalizeContent(content);
  if (!normalized) throw new Error("Missing content for chat RAG document embedding");

  const rendered = renderTemplate(chatRagConfig.documentEmbeddingTemplate, {
    content: normalized,
  }).trim();
  if (!rendered) throw new Error("CHAT_RAG_DOCUMENT_EMBEDDING_TEMPLATE cannot render empty");
  return rendered;
}

function splitTextIntoChunks(text) {
  const normalized = normalizeContent(text);
  if (!normalized) return [];

  const maxChars = Number(chatRagConfig.chunkMaxChars);
  const overlapChars = Number(chatRagConfig.chunkOverlapChars);
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error("Invalid CHAT_RAG_CHUNK_MAX_CHARS");
  if (!Number.isFinite(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("Invalid CHAT_RAG_CHUNK_OVERLAP_CHARS");
  }

  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + maxChars);
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = end - overlapChars;
  }

  return chunks.filter(Boolean);
}

function buildTurnChunks({ userContent, assistantContent } = {}) {
  const text = buildTurnText({ userContent, assistantContent });
  const sourceHash = hashContent(text);
  const embeddingText = buildEmbeddingText({ userContent, assistantContent });
  return splitTextIntoChunks(text).map((content, index) => ({
    chunkIndex: index,
    content,
    embeddingText,
    sourceHash,
  }));
}

return Object.freeze({
  buildTurnChunks,
  buildEmbeddingText,
  buildDocumentEmbeddingText,
  hashContent,
});
}

module.exports = { createChatRagChunker };
