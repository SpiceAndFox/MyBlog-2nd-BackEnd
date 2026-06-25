"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeTemplate, renderTemplate } = require("../../services/chat/rag/templates");

const envExamplePath = path.join(__dirname, "../../.env.example");
const content = fs.readFileSync(envExamplePath, "utf8");

function readEnvValue(key) {
  const prefix = `${key}=`;
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Missing env key: ${key}`);
  return line.slice(prefix.length);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`ASSERT FAILED: ${label} must not contain "${needle}"`);
  }
}

const contextHeader = normalizeTemplate(readEnvValue("CHAT_RAG_CONTEXT_HEADER"));
const contextEntryTemplate = normalizeTemplate(readEnvValue("CHAT_RAG_CONTEXT_ENTRY_TEMPLATE"));
const recallTemplate = normalizeTemplate(readEnvValue("CHAT_RAG_RECALL_TEMPLATE"));
const scenePrompt = normalizeTemplate(readEnvValue("CHAT_RAG_SCENE_RECALL_PROMPT"));

assert(contextHeader.includes("[更早的共同记忆]"), "contextHeader should frame RAG as shared memory");
assert(contextHeader.includes("旧情景素材"), "contextHeader should describe old context as scene material");
assertNotContains(contextHeader, "知识库", "contextHeader");
assertNotContains(contextHeader, "RAG", "contextHeader");
assertNotContains(contextHeader, "检索结果", "contextHeader");

assert(contextEntryTemplate === "{{recall}}", "contextEntryTemplate must render recall only");
assert(recallTemplate.includes("{{scene}}"), "recallTemplate must render scene");
assert(recallTemplate.includes("{{dialogue}}"), "recallTemplate must render dialogue");
assertNotContains(recallTemplate, "你曾对我说过", "recallTemplate");
assertNotContains(recallTemplate, "用户曾经说过", "recallTemplate");
assertNotContains(recallTemplate, "使用方式", "recallTemplate");

assert(scenePrompt.includes("旧对话情景还原器"), "scene prompt should define the cheap scene recall task");
assert(scenePrompt.includes("不编造"), "scene prompt should forbid invention");
assert(scenePrompt.includes("{{max_chars}}"), "scene prompt should include max_chars variable");

const renderedRecall = renderTemplate(recallTemplate, {
  scene: "当时你们处在航海角色扮演中，用户追问助手为什么想当水手，气氛像甲板边的闲谈。",
  dialogue: "User：「你为什么想当水手（我坐到你旁边抽起了烟）」\nAssistant：小时候住矿山，只有下雨时沟里会积出小水洼。",
});
const renderedEntry = renderTemplate(contextEntryTemplate, { recall: renderedRecall });

assert(renderedEntry.includes("当时情景："), "rendered entry should include scene heading");
assert(renderedEntry.includes("相关对话："), "rendered entry should include dialogue heading");
assert(renderedEntry.includes("User：「你为什么想当水手"), "rendered entry should include user line");
assert(renderedEntry.includes("Assistant：小时候住矿山"), "rendered entry should include assistant line");
assertNotContains(renderedEntry, "相似度", "rendered entry");
assertNotContains(renderedEntry, "消息=", "rendered entry");

console.log("render-templates.verify OK: templates render scene recall plus dialogue");
