const test = require("node:test");
const assert = require("node:assert/strict");

const { createContextSegmentBuilder } = require("../../modules/chat/application/context/segmentRegistry");

test("context segment assembly uses injected time and Gist configuration in the stable segment order", () => {
  const build = createContextSegmentBuilder({
    contextConfig: { recentWindowAssistantGistPrefix: "[gist]" },
    timeContextConfig: {
      enabled: true,
      timeZone: "UTC",
      template: "now={{now}} gap={{gap_human}} zone={{time_zone}}",
    },
  });
  const messages = build({
    systemPrompt: "system",
    memoryV2: null,
    ragContext: null,
    gapBridge: null,
    recent: {
      messages: [
        { role: "assistant", content: "[gist] previous answer" },
        { role: "user", content: "current question" },
      ],
      stats: { assistantAntiEcho: { assistantGistUsed: 1 } },
    },
    timeContext: { nowMs: Date.parse("2026-07-22T12:34:56.000Z"), lastMs: null, gapMs: 65_000 },
  });

  assert.equal(messages[0].content, "system");
  assert.match(messages[1].content, /now=2026-07-22 12:34:56 gap=1m 5s zone=UTC/);
  assert.match(messages[2].content, /\[gist\]/);
  assert.deepEqual(messages.slice(-2), [
    { role: "assistant", content: "[gist] previous answer" },
    { role: "user", content: "current question" },
  ]);
});
