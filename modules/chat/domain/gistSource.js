const { createHash } = require("node:crypto");

function hashGistContent(content) {
  return createHash("sha256").update(String(content || "").trim()).digest("hex");
}

function gistSourceFingerprint(source) {
  return hashGistContent(JSON.stringify([
    String(source.content || "").trim(),
    source.userMessageId == null ? null : String(source.userMessageId),
    String(source.userContent || "").trim(),
  ]));
}

module.exports = { hashGistContent, gistSourceFingerprint };
