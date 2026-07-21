const crypto = require("node:crypto");

function contentHash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex")}`;
}

module.exports = { contentHash };
