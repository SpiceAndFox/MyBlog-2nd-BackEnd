"use strict";

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { buildTurnChunks } = require("../../services/chat/rag/chunker");

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const HEX64 = /^[0-9a-f]{64}$/;

const chunks = buildTurnChunks({
  userContent: "你好，还记得我之前叫你船长吗",
  assistantContent: "记得，你之前确实这样叫过我。",
});

assert(Array.isArray(chunks) && chunks.length >= 1, "buildTurnChunks must return at least one chunk");

for (const [index, chunk] of chunks.entries()) {
  assert(
    chunk.embeddingText.includes("用户：\n你好，还记得我之前叫你船长吗"),
    `chunk[${index}].embeddingText must include the user side of the turn`
  );
  assert(
    chunk.embeddingText.includes("助手：\n记得，你之前确实这样叫过我。"),
    `chunk[${index}].embeddingText must include the assistant side of the turn`
  );
  assert(
    !chunk.embeddingText.includes("[历史聊天回合]"),
    `chunk[${index}].embeddingText should stay semantic and not include display wrappers`
  );
  assert(
    typeof chunk.content === "string" && chunk.content.includes("用户："),
    `chunk[${index}].content must still contain the parseable user display text`
  );
  assert(
    typeof chunk.content === "string" && chunk.content.includes("助手："),
    `chunk[${index}].content must still contain the parseable assistant display text`
  );
  assert(
    typeof chunk.sourceHash === "string" && HEX64.test(chunk.sourceHash),
    `chunk[${index}].sourceHash must be a 64-char sha256 hex string`
  );
  assert(Number.isInteger(chunk.chunkIndex) && chunk.chunkIndex >= 0, `chunk[${index}].chunkIndex must be non-negative`);
}

const longUser = "x".repeat(2000);
const longAssistant = "assistant reply";
const multiChunks = buildTurnChunks({
  userContent: longUser,
  assistantContent: longAssistant,
});

assert(Array.isArray(multiChunks) && multiChunks.length >= 2, "long turn must split into multiple display chunks");

for (const [index, chunk] of multiChunks.entries()) {
  assert(
    chunk.embeddingText.includes(longUser) && chunk.embeddingText.includes(longAssistant),
    `multiChunks[${index}].embeddingText must keep the full turn semantics on every chunk`
  );
}

const uniqueHashes = new Set(multiChunks.map((chunk) => chunk.sourceHash));
assert(uniqueHashes.size === 1, "all chunks of one turn must share one sourceHash");

if (failures.length > 0) {
  console.error("chunker.verify FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}

console.log("chunker.verify OK: embeddingText includes user and assistant semantics");
