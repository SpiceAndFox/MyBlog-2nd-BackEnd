// Shared contract shape only. Values come from explicit environment configuration
// and are captured in each task for schema binding, validation and reduction.
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

const WRITE_LIMIT_KEYS = Object.freeze(Object.fromEntries(Object.keys(SECTION_ACTIONS).map(section => [
  section,
  Object.freeze(["maxItemChars", "maxSourceRefs", ...(section === "recentEpisodes" ? ["maxAppendChars"] : [])]),
])));

const EPISODE_APPEND_SEPARATOR = " → ";
function codePointLength(value) { return Array.from(value || "").length; }
function sectionLimits(section, task) {
  const limits = task?.writeLimits?.[section];
  if (!WRITE_LIMIT_KEYS[section] || !limits
    || WRITE_LIMIT_KEYS[section].some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1)
    || limits.maxAppendChars > limits.maxItemChars) {
    throw new Error(`Missing or invalid task.writeLimits.${section}; recreate the task with explicit Memory configuration`);
  }
  return limits;
}
function captureWriteLimits(config) {
  return Object.fromEntries(Object.entries(WRITE_LIMIT_KEYS).map(([section, keys]) => {
    const budget = section === "scene" ? config?.scene : config?.sectionBudgets?.[section];
    const limits = Object.fromEntries(keys.map(key => {
      const value = budget?.[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${section}.${key}`);
      return [key, value];
    }));
    if (limits.maxAppendChars > limits.maxItemChars) throw new Error(`Invalid ${section}.maxAppendChars`);
    return [section, limits];
  }));
}

function validateWriteLimits(limits) {
  const errors = [];
  const fail = (path) => errors.push({ path: `$.publicInput.task.writeLimits${path ? `.${path}` : ""}`, message: "must match the positive integer section limits" });
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) { fail(""); return errors; }
  for (const key of Object.keys(limits)) if (!WRITE_LIMIT_KEYS[key]) fail(key);
  for (const [section, keys] of Object.entries(WRITE_LIMIT_KEYS)) {
    const value = limits[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) { fail(section); continue; }
    for (const key of new Set([...keys, ...Object.keys(value)])) {
      if (!keys.includes(key) || !Number.isSafeInteger(value[key]) || value[key] < 1) fail(`${section}.${key}`);
    }
    if (value.maxAppendChars > value.maxItemChars) fail(`${section}.maxAppendChars`);
  }
  return errors;
}

module.exports = { SECTION_ACTIONS, WRITE_LIMIT_KEYS, EPISODE_APPEND_SEPARATOR, codePointLength, sectionLimits, captureWriteLimits, validateWriteLimits };
