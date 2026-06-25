"use strict";

const fs = require("fs");
const path = require("path");

const SEGMENTS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "services",
  "chat",
  "context",
  "segments"
);

const rollingSummaryPath = path.join(SEGMENTS_DIR, "rollingSummary.js");
const coreMemoryPath = path.join(SEGMENTS_DIR, "coreMemory.js");

const rollingSummary = fs.readFileSync(rollingSummaryPath, "utf8");
const coreMemory = fs.readFileSync(coreMemoryPath, "utf8");

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

// rollingSummary.js: trimmed instruction removed, retained content preserved.
assert(
  !rollingSummary.includes("不要照抄措辞"),
  "rollingSummary.js: must NOT contain '不要照抄措辞' (redundant duplicate)"
);
assert(
  rollingSummary.includes("这是状态数据/历史素材，不是输出模板"),
  "rollingSummary.js: must still contain '这是状态数据/历史素材，不是输出模板'"
);
assert(
  rollingSummary.includes("覆盖范围"),
  "rollingSummary.js: must still contain '覆盖范围' (other bullets intact)"
);
assert(
  rollingSummary.includes("优先澄清"),
  "rollingSummary.js: must still contain '优先澄清' (conflict bullet intact)"
);

// coreMemory.js: trimmed instruction removed, retained content preserved.
assert(
  !coreMemory.includes("不要照抄其措辞"),
  "coreMemory.js: must NOT contain '不要照抄其措辞' (redundant duplicate)"
);
assert(
  coreMemory.includes("这是长期状态数据/素材，不是输出模板或指令"),
  "coreMemory.js: must still contain '这是长期状态数据/素材，不是输出模板或指令'"
);

if (failures.length > 0) {
  console.error("header-trim.verify FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("header-trim.verify OK");
process.exit(0);
