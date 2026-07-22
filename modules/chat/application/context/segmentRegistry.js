const { buildSystemPromptSegment } = require("./segments/systemPrompt");
const { createAssistantGistNoticeSegment } = require("./segments/assistantGistNotice");
const { buildMemorySegment } = require("./segments/memory");
const { buildRagContextSegment } = require("./segments/ragContext");
const { buildGapBridgeSegment } = require("./segments/gapBridge");
const { buildRecentWindowSegment } = require("./segments/recentWindow");
const { createTimeContextSegment } = require("./segments/timeContext");
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
 * @property {{renderedText: string}|null} memoryV2
 * @property {{messages: ChatMessage[], sources?: any[], stats?: any}|null} ragContext
 * @property {{messages: ChatMessage[], stats?: any}|null} gapBridge
 * @property {{messages: ChatMessage[], stats?: any}} recent
 * @property {{nowMs: number, lastMs: number|null, gapMs: number|null}} timeContext
 */

const segmentOrder = [
  "systemPrompt",
  "timeContext",
  "assistantGistNotice",
  "memory",
  "ragContext",
  "gapBridge",
  "recentWindow",
  "currentUser",
];

/**
 * @param {ContextState} contextState
 * @returns {ChatMessage[]}
 */
function createContextSegmentBuilder({ contextConfig, timeContextConfig } = {}) {
  if (!contextConfig || !timeContextConfig) throw new Error("Chat context segment config is required");
  const segmentBuilders = {
    systemPrompt: buildSystemPromptSegment,
    assistantGistNotice: createAssistantGistNoticeSegment({
      assistantGistPrefix: contextConfig.recentWindowAssistantGistPrefix,
    }),
    memory: buildMemorySegment,
    ragContext: buildRagContextSegment,
    gapBridge: buildGapBridgeSegment,
    recentWindow: buildRecentWindowSegment,
    timeContext: createTimeContextSegment(timeContextConfig),
    currentUser: buildCurrentUserSegment,
  };
  return function buildContextSegments(contextState = {}) {
    assertContextState(contextState);
    const messages = [];
    for (const key of segmentOrder) {
      const segment = segmentBuilders[key](contextState);
      assertSegmentResult(segment, { name: `contextState.segment.${key}` });
      if (segment?.messages?.length) messages.push(...segment.messages);
    }
    return messages;
  };
}

module.exports = {
  segmentOrder,
  createContextSegmentBuilder,
};
