const { SAFE_NORMALIZATIONS } = require("./policy");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeSemanticOutput(value) {
  if (!isPlainObject(value)) return { output: value, applied: [] };
  const output = structuredClone(value);
  const applied = [];
  if (!isPlainObject(output.sectionResults)) return { output, applied };
  for (const [section, result] of Object.entries(output.sectionResults)) {
    if (!isPlainObject(result) || result.status !== "changes" || !Array.isArray(result.changes)) continue;
    if (result.changes.length === 0) {
      output.sectionResults[section] = { status: "noop" };
      applied.push({ code: SAFE_NORMALIZATIONS.EMPTY_CHANGES_TO_NOOP, section });
      continue;
    }
    for (const change of result.changes) {
      if (!isPlainObject(change)) continue;
      for (const field of ["evidenceMessageIds", "supportRefs"]) {
        if (Array.isArray(change[field]) && change[field].length === 0) {
          delete change[field];
          applied.push({ code: SAFE_NORMALIZATIONS.REMOVE_EMPTY_SOURCE_ARRAYS, section, field });
        }
      }
    }
  }
  return { output, applied };
}

module.exports = { normalizeSemanticOutput };
