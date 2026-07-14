const crypto = require("node:crypto");

const ITEM_SECTIONS = [
  "todos", "standingAgreements", "recentEpisodes", "milestones",
  "worldFacts", "userProfile", "assistantProfile", "relationship",
];

function createSectionBudgets(maxItems = 20, maxRenderedChars = 2000) {
  return Object.fromEntries(ITEM_SECTIONS.map((section) => [section, { maxItems, maxRenderedChars }]));
}

function createMemoryTestConfig(overrides = {}) {
  const base = {
    quote: { threshold: 0.75, maxCodePoints: 200 },
    scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
    overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
    sectionBudgets: createSectionBudgets(),
  };
  return {
    ...base,
    ...overrides,
    quote: { ...base.quote, ...overrides.quote },
    scene: { ...base.scene, ...overrides.scene },
    overdueTodos: { ...base.overdueTodos, ...overrides.overdueTodos },
    sectionBudgets: overrides.sectionBudgets || base.sectionBudgets,
  };
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function sequence(...values) {
  let index = 0;
  return () => values[index++] || `id-${index}`;
}

module.exports = { ITEM_SECTIONS, createSectionBudgets, createMemoryTestConfig, sha256, sequence };
