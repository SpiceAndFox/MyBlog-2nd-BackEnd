const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadFixtures, executeReducerTick } = require("../../modules/memory/harness/runner");

function budgets() {
  return Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]));
}
const config = { quote: { threshold: 0.75, maxCodePoints: 200 }, scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 }, sectionBudgets: budgets() };

test("stage 3 normal pipeline fixture locks noop cursor revision semantics", () => {
  const entries = loadFixtures(path.join(__dirname, "../../modules/memory/harness/fixtures"));
  const fixture = entries.find((entry) => entry.fixture.name === "normal-todo-noop-atomic-commit").fixture;
  const tick = fixture.ticks[0];
  const result = executeReducerTick(fixture, tick, { config, idFactory: () => "unused" });
  assert.equal(result.outcome, tick.expected.outcome);
  assert.equal(result.state.meta.revision, tick.expected.revision);
  assert.equal(result.state.meta.targetCursors.todos, tick.expected.cursorAfter);
  assert.equal(result.events[0].decision, tick.expected.decision);
});
