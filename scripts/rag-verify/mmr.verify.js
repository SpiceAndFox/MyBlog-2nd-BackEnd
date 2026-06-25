"use strict";

const path = require("path");
const assert = require("assert");

require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

if (!process.env.CHAT_RAG_MMR_LAMBDA) process.env.CHAT_RAG_MMR_LAMBDA = "0.7";
if (!process.env.CHAT_RAG_MMR_CANDIDATE_MULTIPLIER) process.env.CHAT_RAG_MMR_CANDIDATE_MULTIPLIER = "3";

const retrieverPath = path.resolve(__dirname, "..", "..", "services", "chat", "rag", "retriever.js");

let retriever;
try {
  retriever = require(retrieverPath);
} catch (error) {
  console.error("FAILED to load retriever module:", error.message);
  process.exit(1);
}

const { parseEmbeddingVector, mmrSelect } = retriever;

let failures = 0;

function check(label, cond) {
  if (cond) {
    console.log(`  [ok] ${label}`);
  } else {
    console.error(`  [FAIL] ${label}`);
    failures++;
  }
}

function expectThrow(label, fn) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}

function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

console.log("Test 1: parseEmbeddingVector");

if (typeof parseEmbeddingVector !== "function") {
  console.error("  [FAIL] parseEmbeddingVector is not exported");
  failures++;
} else {
  check(
    "parseEmbeddingVector('[1,2,3]') returns [1,2,3]",
    arrEq(parseEmbeddingVector("[1,2,3]"), [1, 2, 3])
  );
  check(
    "parseEmbeddingVector('[0.1, 0.2, 0.3]') (with spaces) returns [0.1,0.2,0.3]",
    arrEq(parseEmbeddingVector("[0.1, 0.2, 0.3]"), [0.1, 0.2, 0.3])
  );
  expectThrow("parseEmbeddingVector('') throws", () => parseEmbeddingVector(""));
  expectThrow("parseEmbeddingVector('[]') throws (empty content)", () => parseEmbeddingVector("[]"));
}

console.log("Test 2: mmrSelect cluster diversification");

if (typeof mmrSelect !== "function") {
  console.error("  [FAIL] mmrSelect is not exported");
  failures++;
} else {
  const c1 = { id: "c1", similarity: 0.9, embedding: [1, 0, 0] };
  const c2 = { id: "c2", similarity: 0.9, embedding: [0.99, 0.01, 0] };
  const c3 = { id: "c3", similarity: 0.9, embedding: [0.98, 0.02, 0] };
  const c4 = { id: "c4", similarity: 0.9, embedding: [0, 0, 1] };
  const candidates = [c1, c2, c3, c4];

  const selected = mmrSelect(candidates, 3, 0.7);
  const selectedIds = selected.map((c) => c.id);

  check(`result length <= 3 (got ${selected.length})`, selected.length <= 3);
  check(`c4 is in result (got ${JSON.stringify(selectedIds)})`, selectedIds.includes("c4"));
  check(
    `NOT all of c1,c2,c3 are present (got ${JSON.stringify(selectedIds)})`,
    !(selectedIds.includes("c1") && selectedIds.includes("c2") && selectedIds.includes("c3"))
  );

  check("mmrSelect([], k, lambda) returns []", arrEq(mmrSelect([], 3, 0.7), []));
  check(
    "mmrSelect returns all when candidates.length <= k",
    mmrSelect([c1, c2], 5, 0.7).length === 2
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log("\nOK: MMR diversifies cluster");
process.exit(0);