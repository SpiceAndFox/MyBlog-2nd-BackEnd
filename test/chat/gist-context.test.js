const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecentGistRenderer } = require("../../modules/chat/application/context/renderRecentGists");
const { createChatContextCompiler } = require("../../modules/chat/application/contextCompiler");
const { hashGistContent, gistSourceFingerprint } = require("../../modules/chat/domain/gistSource");

function fixture({ enabled = true, failRead = false } = {}) {
  const sources = [
    { id: 1, role: "user", content: "question" },
    { id: 2, role: "assistant", content: "first long assistant response" },
    { id: 3, role: "user", content: "second question" },
    { id: 4, role: "assistant", content: "second long assistant response" },
    { id: 5, role: "user", content: "third question" },
    { id: 6, role: "assistant", content: "latest response remains verbatim" },
  ];
  const recent = { messages: sources.map(({ role, content }) => ({ role, content })),
    stats: { selectedChars: 100, windowStartMessageId: 1, windowEndMessageId: 6 } };
  const calls = [];
  const rows = [{ messageId: 2, gistText: "short", contentHash: hashGistContent(sources[1].content),
    userMessageId: 1, sourceHash: gistSourceFingerprint({ content: sources[1].content, userMessageId: 1, userContent: sources[0].content }) }];
  const render = createRecentGistRenderer({ config: { enabled },
    contextConfig: { recentWindowAssistantGistEnabled: true, recentWindowAssistantRawLastN: 1, recentWindowAssistantGistPrefix: "[gist]" },
    gistRepository: { async listGistsByMessageIds() { if (failRead) throw new Error("db unavailable"); return rows; } },
    gist: { scheduleBackfill(value) { calls.push(value); return { scheduled: value.gistBackfillCandidates.length }; } },
    logger: { warn() {} },
  });
  return { sources, recent, rows, render, calls };
}

test("v2 uses cached gists only for older assistant turns and schedules missing ones", async () => {
  const f = fixture(); const original = structuredClone(f.recent);
  const result = await f.render({ userId: 1, presetId: "p", recent: f.recent, sourceMessages: f.sources });
  assert.equal(result.messages[1].content, "[gist] short");
  assert.equal(result.messages[3].content, f.sources[3].content);
  assert.equal(result.messages[5].content, f.sources[5].content);
  assert.equal(result.messages[0].content, "question");
  assert.deepEqual(f.calls[0].gistBackfillCandidates.map(x => x.messageId), [4]);
  assert.equal(result.stats.selectedChars, 100);
  assert.equal(result.stats.windowStartMessageId, 1);
  assert.deepEqual(f.recent, original);
});

test("stale or oversized cache entries fall back to raw, disabled/read-failure paths preserve context", async () => {
  const f = fixture(); f.rows[0].contentHash = "old";
  assert.deepEqual((await f.render({ recent: f.recent, sourceMessages: f.sources })).messages, f.recent.messages);
  assert.deepEqual(f.calls[0].gistBackfillCandidates.map(x => x.messageId), [2, 4]);
  f.rows[0].contentHash = hashGistContent(f.sources[1].content); f.rows[0].gistText = "long".repeat(100);
  assert.deepEqual((await f.render({ recent: f.recent, sourceMessages: f.sources })).messages, f.recent.messages);
  for (const options of [{ enabled: false }, { failRead: true }]) {
    const g = fixture(options);
    assert.equal(await g.render({ recent: g.recent, sourceMessages: g.sources }), g.recent);
    assert.equal(g.calls.length, 0);
  }
});

test("compiler replaces only recent rendering; coverage, raw gap and memory remain authoritative", async () => {
  const f = fixture();
  const context = { recent: f.recent, recentSourceMessages: f.sources, timeCandidates: f.sources,
    memorySegment: "memory", needsMemory: true, gapBridge: { messages: [{ content: "raw gap" }], stats: {} },
    coverage: { complete: true }, health: { status: "healthy" } };
  let state;
  const compile = createChatContextCompiler({ memoryEnabled: true,
    memory: { async assembleContext() { return context; } }, recentWindow: { build() { throw new Error("legacy path"); } },
    segments: { build(input) { state = input; return input.recent.messages; } },
    timeContext: { build() { return {}; } }, gist: { scheduleBackfill() {} }, renderRecentGists: f.render });
  const result = await compile({ userId: 1, presetId: "p" });
  assert.equal(result.messages[1].content, "[gist] short");
  assert.equal(result.needsMemory, true); assert.equal(result.memoryCoverage, context.coverage);
  assert.equal(state.gapBridge, context.gapBridge); assert.equal(state.memoryV2.renderedText, "memory");
  assert.equal(context.recent.messages[1].content, f.sources[1].content);
});

test("a gist based on an edited user input cannot attach to an older chat snapshot", async () => {
  const f = fixture();
  f.rows[0].sourceHash = gistSourceFingerprint({ content: f.sources[1].content, userMessageId: 1, userContent: "edited question" });
  const rendered = await f.render({ recent: f.recent, sourceMessages: f.sources });
  assert.equal(rendered.messages[1].content, f.sources[1].content);
  assert.deepEqual(f.calls[0].gistBackfillCandidates.map(row => row.messageId), [2, 4]);
});
