const { sectionLimits, codePointLength } = require("../contracts/sectionPolicy");

function rejectWrite(reason, section, detail = {}) {
  const error = new Error(`Memory write rejected: ${reason}`);
  error.code = "MEMORY_WRITE_GUARD_INVALID";
  error.reason = reason;
  error.validationErrors = [{
    ...(["text_length_exceeded", "append_length_exceeded"].includes(reason) ? { code: "TEXT_LENGTH_EXCEEDED" } : {}),
    path: `$.sectionResults.${section}`,
    message: `${reason}${detail.limit === undefined ? "" : ` (limit=${detail.limit}, actual=${detail.actual})`}`,
    meta: { section, ...detail },
  }];
  throw error;
}

function assertItemLimits(section, text, sourceRefs, task) {
  const limits = sectionLimits(section, task);
  const chars = codePointLength(text);
  if (chars > limits.maxItemChars) rejectWrite("text_length_exceeded", section, { limit: limits.maxItemChars, actual: chars });
  if (sourceRefs.length > limits.maxSourceRefs) rejectWrite("source_limit_exceeded", section, { limit: limits.maxSourceRefs, actual: sourceRefs.length });
}

module.exports = { rejectWrite, assertItemLimits };
