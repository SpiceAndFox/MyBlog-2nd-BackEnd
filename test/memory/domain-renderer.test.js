const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { renderMemory, renderOverdueTodosWithinBudget } = require("../../modules/memory/domain");

const config = {
  scene: { ttlMs: 60_000, maxRenderedChars: 1000 },
  overdueTodos: { maxRenderedItems: 2, maxRenderedChars: 1000 },
  sectionBudgets: { recentEpisodes: { maxItems: 20, maxRenderedChars: 2000 } },
};
const ref = { messageId: 1, contentHash: "sha256:1", quote: "在屋顶" };

test("empty renderer output is locked by a complete golden file", () => {
  const rendered = renderMemory({ state: createInitialMemoryState(), requestNow: "2026-01-01T00:00:00.000Z", config }).renderedText;
  const golden = fs.readFileSync(path.join(__dirname, "../../modules/memory/harness/golden/renderer-empty.txt"), "utf8").trimEnd();
  assert.equal(rendered, golden);
});

test("renderer consumes effective view and labels stale/rebuilding targets without mutating state", () => {
  const state = createInitialMemoryState();
  state.current.scene.location = { value: "屋顶", evidenceRef: ref, updatedAtMessageId: 1 };
  state.longTerm.milestones.push({ id: "milestone:1", text: "第一次互相信任", evidenceGroups: [{ evidenceKind: "relationship_milestone", refs: [ref] }], createdAtMessageId: 1, updatedAtMessageId: 1 });
  state.working.recentEpisodes.push({ id: "episode:1", text: "雨夜和解", evidenceGroups: [{ evidenceKind: "recent_episode", refs: [ref] }], createdAtMessageId: 1, updatedAtMessageId: 1 });
  const result = renderMemory({ state, lifecycleAnchors: { sceneAnchorCreatedAt: "2026-01-01T00:00:00.000Z" }, requestNow: "2026-01-01T00:01:00.000Z", config, targetStatuses: { episodes: "halted", scene: "rebuilding" } });
  assert.equal(result.needsHousekeeping, true);
  assert.match(result.renderedText, /\[已过期场景 \/ 上次已知场景\]\n- 地点: 屋顶/);
  assert.equal((result.renderedText.match(/\[该类记忆可能滞后\]/g) || []).length, 2);
  assert.equal((result.renderedText.match(/\[该类记忆正在重建\]/g) || []).length, 1);
  assert.equal(state.current.scene.location.value, "屋顶");
});

test("overdue renderer sorts stably and never truncates an item", () => {
  const todo = (id, text, becameOverdueAt) => ({ id, text, actor: "user", requester: "assistant", status: "overdue", becameOverdueAt, dueAt: becameOverdueAt });
  const todos = [todo("b", "较早", "2026-01-01T00:00:00.000Z"), todo("a", "同日A", "2026-01-02T00:00:00.000Z"), todo("c", "同日C", "2026-01-02T00:00:00.000Z")];
  const rendered = renderOverdueTodosWithinBudget(todos, { maxRenderedItems: 2, maxRenderedChars: 1000 });
  assert.ok(rendered.indexOf("同日A") < rendered.indexOf("同日C"));
  assert.doesNotMatch(rendered, /较早/);
  assert.equal(renderOverdueTodosWithinBudget(todos, { maxRenderedItems: 3, maxRenderedChars: 2 }), "(无)");
});
