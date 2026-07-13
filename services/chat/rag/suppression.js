const crypto = require("node:crypto");

function contentHash(content) {
  return `sha256:${crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex")}`;
}

function sourceKey(messageId, hash) {
  return `${Number(messageId)}\u0000${String(hash || "")}`;
}

function tombstoneKeySet(tombstones) {
  return new Set((Array.isArray(tombstones) ? tombstones : []).map((row) => sourceKey(
    row.message_id ?? row.messageId,
    row.content_hash ?? row.contentHash,
  )));
}

function sourceRefsForChunk(chunk) {
  const refs = chunk?.sourceRefs ?? chunk?.source_refs ?? chunk?.metadata?.sourceRefs;
  return Array.isArray(refs) ? refs : [];
}

function filterRagChunks(chunks, tombstones, { requireSourceRefs = false } = {}) {
  const keys = tombstoneKeySet(tombstones);
  return (Array.isArray(chunks) ? chunks : []).filter((chunk) => {
    const refs = sourceRefsForChunk(chunk);
    if (!refs.length) return !requireSourceRefs && keys.size === 0;
    return !refs.some((ref) => keys.has(sourceKey(ref.messageId, ref.contentHash)));
  });
}

function filterSuppressedMessages(messages, tombstones) {
  const keys = tombstoneKeySet(tombstones);
  if (!keys.size) return Array.isArray(messages) ? messages.slice() : [];
  return (Array.isArray(messages) ? messages : []).filter((message) => !keys.has(sourceKey(
    message.id ?? message.messageId,
    message.contentHash || contentHash(message.content),
  )));
}

function sourceRefsAreSuppressed(sourceRefs, tombstones) {
  const keys = tombstoneKeySet(tombstones);
  return (Array.isArray(sourceRefs) ? sourceRefs : []).some((ref) => keys.has(sourceKey(ref.messageId, ref.contentHash)));
}

module.exports = {
  contentHash,
  sourceKey,
  tombstoneKeySet,
  sourceRefsForChunk,
  filterRagChunks,
  filterSuppressedMessages,
  sourceRefsAreSuppressed,
};
