const { ITEM_SECTIONS, SCENE_FIELDS } = require("../contracts/constants");

function codePointLength(value) { return Array.from(value || "").length; }

function itemRenderedChars(item, section) {
  let length = codePointLength(item.text);
  if (section === "todos") {
    length += codePointLength(item.actor) + codePointLength(item.requester);
    if (item.dueAt) length += codePointLength(item.dueAt);
  }
  return length;
}

function measureSection(state, section) {
  if (section === "scene") {
    return { renderedChars: SCENE_FIELDS.reduce((sum, field) => sum + codePointLength(state.current.scene[field].value), 0) };
  }
  const container = ["todos", "standingAgreements", "recentEpisodes"].includes(section) ? state.working : state.longTerm;
  const items = section === "todos" ? container[section].filter((item) => item.status === "active") : container[section];
  return { items: items.length, renderedChars: items.reduce((sum, item) => sum + itemRenderedChars(item, section), 0) };
}

function findCapacityViolation(state, config, sections = ["scene", ...ITEM_SECTIONS]) {
  for (const section of sections) {
    const measured = measureSection(state, section);
    if (section === "scene") {
      const limit = config.scene.maxRenderedChars;
      if (measured.renderedChars > limit) return { section, dimension: "maxRenderedChars", limit, actual: measured.renderedChars };
      continue;
    }
    if (section === "recentEpisodes") continue;
    const budget = config.sectionBudgets[section];
    if (measured.items > budget.maxItems) return { section, dimension: "maxItems", limit: budget.maxItems, actual: measured.items };
    if (measured.renderedChars > budget.maxRenderedChars) return { section, dimension: "maxRenderedChars", limit: budget.maxRenderedChars, actual: measured.renderedChars };
  }
  return null;
}

module.exports = { codePointLength, itemRenderedChars, measureSection, findCapacityViolation };
