"use strict";

const fs = require("fs");
const path = require("path");

const envExamplePath = path.resolve(__dirname, "..", "..", ".env.example");
const envExample = fs.readFileSync(envExamplePath, "utf8");

function readEnvTemplateValue(text, key) {
  const prefix = `${key}=`;
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

const expected = {
  CHAT_RAG_TOP_K: "3",
  CHAT_RAG_MAX_CONTEXT_CHARS: "1800",
  CHAT_RAG_RECALL_CONTENT_MAX_CHARS: "160",
  CHAT_RAG_RECALL_ASSISTANT_MAX_CHARS: "420",
  CHAT_RAG_RECALL_INCLUDE_ASSISTANT: "true",
  CHAT_RAG_RECALL_USER_MAX_CHARS: "140",
  CHAT_RAG_CONTEXT_BEFORE_MESSAGES: "2",
  CHAT_RAG_CONTEXT_AFTER_MESSAGES: "0",
  CHAT_RAG_SCENE_RECALL_ENABLED: "true",
  CHAT_RAG_SCENE_RECALL_PROVIDER: "deepseek",
  CHAT_RAG_SCENE_RECALL_MODEL: "deepseek-v4-flash",
  CHAT_RAG_SCENE_RECALL_CONTEXT_TURNS: "50",
  CHAT_RAG_SCENE_RECALL_MAX_INPUT_CHARS: "12000",
  CHAT_RAG_SCENE_RECALL_MAX_OUTPUT_CHARS: "700",
  CHAT_RAG_SCENE_RECALL_TIMEOUT_MS: "20000",
  CHAT_RAG_SCENE_RECALL_TEMPERATURE: "0.2",
  CHAT_RAG_SCENE_RECALL_TOP_P: "0.9",
  CHAT_RAG_SCENE_RECALL_MAX_OUTPUT_TOKENS: "1024",
  CHAT_RAG_SCENE_RECALL_DEEPSEEK_THINKING_MODE: "disabled",
  CHAT_RAG_SCENE_RECALL_OPENAI_COMPATIBLE_BODY_JSON: "{}",
  CHAT_RAG_SCENE_RECALL_GOOGLE_GENAI_CONFIG_JSON: "{}",
};

const mustNotChange = {
  CHAT_RAG_MIN_QUERY_CHARS: "8",
  CHAT_RAG_CHUNK_MAX_CHARS: "1200",
  CHAT_RAG_CHUNK_OVERLAP_CHARS: "120",
};

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

for (const [key, expectedValue] of Object.entries(expected)) {
  const actual = readEnvTemplateValue(envExample, key);
  assert(actual !== null, `.env.example: ${key} line must exist`);
  assert(actual === expectedValue, `.env.example: ${key} must be ${expectedValue}, got ${actual}`);
}

for (const [key, expectedValue] of Object.entries(mustNotChange)) {
  const actual = readEnvTemplateValue(envExample, key);
  assert(actual === expectedValue, `.env.example: ${key} must stay ${expectedValue}, got ${actual}`);
}

const scenePrompt = readEnvTemplateValue(envExample, "CHAT_RAG_SCENE_RECALL_PROMPT") || "";
assert(scenePrompt.includes("旧对话情景还原器"), "scene recall prompt must exist and describe the task");
assert(!envExample.includes("CHAT_RAG_SCENE_RECALL_CACHE"), "scene recall cache config must not exist yet");

if (failures.length > 0) {
  console.error("params.verify FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}

console.log("params.verify OK: RAG params include scene recall without cache");
