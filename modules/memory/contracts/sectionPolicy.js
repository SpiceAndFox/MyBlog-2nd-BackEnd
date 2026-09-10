// Shared by schema binding, semantic validation and both reducers. These defaults
// are deliberately small snapshots, not promises about model semantic quality.
const SECTION_ACTIONS = Object.freeze({
  scene: Object.freeze(["set", "correct", "clear", "forget"]),
  todos: Object.freeze(["add", "revise", "correct", "forget", "complete", "cancel", "expire"]),
  standingAgreements: Object.freeze(["add", "revise", "correct", "forget", "cancel"]),
  recentEpisodes: Object.freeze(["add", "append", "correct", "forget"]),
  milestones: Object.freeze(["add", "revise", "correct", "forget"]),
  worldFacts: Object.freeze(["add", "revise", "correct", "forget"]),
  userProfile: Object.freeze(["add", "revise", "correct", "forget"]),
  assistantProfile: Object.freeze(["add", "revise", "correct", "forget"]),
  relationship: Object.freeze(["add", "revise", "correct", "forget"]),
});

const DEFAULT_WRITE_LIMITS = Object.freeze(Object.fromEntries(Object.entries({
  scene: 300, todos: 300, standingAgreements: 300, recentEpisodes: 600,
  milestones: 300, worldFacts: 300, userProfile: 200, assistantProfile: 200,
  relationship: 300,
}).map(([section, maxItemChars]) => [section, Object.freeze({
  maxItemChars,
  maxSourceRefs: section === "recentEpisodes" ? 32 : 16,
  ...(section === "recentEpisodes" ? { maxAppendChars: 160 } : {}),
})])));

const EPISODE_APPEND_SEPARATOR = " → ";
function codePointLength(value) { return Array.from(value || "").length; }
function sectionLimits(section, task) {
  return task?.writeLimits?.[section] || DEFAULT_WRITE_LIMITS[section];
}
function captureWriteLimits(config) {
  return Object.fromEntries(Object.entries(DEFAULT_WRITE_LIMITS).map(([section, defaults]) => {
    const budget = section === "scene" ? config?.scene : config?.sectionBudgets?.[section];
    const limits = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
      const value = budget?.[key] ?? fallback;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${section}.${key}`);
      return [key, value];
    }));
    if (limits.maxAppendChars > limits.maxItemChars) throw new Error(`Invalid ${section}.maxAppendChars`);
    return [section, limits];
  }));
}

function validateWriteLimits(limits) {
  if (limits === undefined) return [];
  const errors = [];
  const fail = (path) => errors.push({ path: `$.publicInput.task.writeLimits.${path}`, message: "must match the positive integer section limits" });
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) { fail(""); return errors; }
  for (const key of Object.keys(limits)) if (!DEFAULT_WRITE_LIMITS[key]) fail(key);
  for (const [section, defaults] of Object.entries(DEFAULT_WRITE_LIMITS)) {
    const value = limits[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) { fail(section); continue; }
    for (const key of new Set([...Object.keys(defaults), ...Object.keys(value)])) {
      if (!(key in defaults) || !Number.isSafeInteger(value[key]) || value[key] < 1) fail(`${section}.${key}`);
    }
    if (value.maxAppendChars > value.maxItemChars) fail(`${section}.maxAppendChars`);
  }
  return errors;
}

module.exports = { SECTION_ACTIONS, DEFAULT_WRITE_LIMITS, EPISODE_APPEND_SEPARATOR, codePointLength, sectionLimits, captureWriteLimits, validateWriteLimits };
