const { buildSystemPromptSegment } = require("./segments/systemPrompt");
const { buildAssistantGistNoticeSegment } = require("./segments/assistantGistNotice");
const { buildCoreMemorySegment } = require("./segments/coreMemory");
const { buildRollingSummarySegment } = require("./segments/rollingSummary");
const { buildRagContextSegment } = require("./segments/ragContext");
const { buildGapBridgeSegment } = require("./segments/gapBridge");
const { buildRecentWindowSegment } = require("./segments/recentWindow");
const { buildTimeContextSegment } = require("./segments/timeContext");
const { buildCurrentUserSegment } = require("./segments/currentUser");
const { assertContextState, assertSegmentResult } = require("./validateContextState");

/**
 * @typedef {Object} ChatMessage
 * @property {string} role
 * @property {string} content
 */

/**
 * @typedef {Object} ContextState
 * @property {string} systemPrompt
 * @property {boolean} coreMemoryEnabled
 * @property {string} coreMemoryText
 * @property {number} coreMemoryChars
 * @property {boolean} rollingSummaryEnabled
 * @property {Object|null} memory
 * @property {{messages: ChatMessage[], sources?: any[], stats?: any}|null} ragContext
 * @property {{messages: ChatMessage[], stats?: any}|null} gapBridge
 * @property {{messages: ChatMessage[], stats?: any}} recent
 * @property {{nowMs: number, lastMs: number|null, gapMs: number|null}} timeContext
 */

const segmentOrder = [
  "systemPrompt",
  "timeContext",
  "assistantGistNotice",
  "coreMemory",
  "rollingSummary",
  "ragContext",
  "gapBridge",
  "recentWindow",
  "currentUser",
];

const segmentBuilders = {
  systemPrompt: buildSystemPromptSegment,
  assistantGistNotice: buildAssistantGistNoticeSegment,
  coreMemory: buildCoreMemorySegment,
  rollingSummary: buildRollingSummarySegment,
  ragContext: buildRagContextSegment,
  gapBridge: buildGapBridgeSegment,
  recentWindow: buildRecentWindowSegment,
  timeContext: buildTimeContextSegment,
  currentUser: buildCurrentUserSegment,
};

/**
 * @param {ContextState} contextState
 * @returns {ChatMessage[]}
 */
function buildContextSegments(contextState = {}) {
  assertContextState(contextState);
  const messages = [];

  for (const key of segmentOrder) {
    const builder = segmentBuilders[key];
    if (!builder) throw new Error(`Missing segment builder: ${key}`);
    const segment = builder(contextState);
    assertSegmentResult(segment, { name: `contextState.segment.${key}` });
    if (!segment?.messages?.length) continue;
    messages.push(...segment.messages);
  }

  return messages;
}

module.exports = {
  segmentOrder,
  segmentBuilders,
  buildContextSegments,
};
