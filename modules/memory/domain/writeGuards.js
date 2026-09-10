const { sectionLimits, codePointLength } = require("../contracts/sectionPolicy");

const ISSUE_CODES = {
  text_length_exceeded: "TEXT_LENGTH_EXCEEDED", append_length_exceeded: "TEXT_LENGTH_EXCEEDED",
  source_limit_exceeded: "SOURCE_LIMIT_EXCEEDED", duplicate_item: "DUPLICATE_ITEM",
  item_not_found: "WRITABLE_REF_INVALID",
};

function rejectWrite(reason, section, detail = {}) {
  const error = new Error(`Memory write rejected: ${reason}`);
  error.code = "MEMORY_WRITE_GUARD_INVALID";
  error.reason = reason;
  error.validationErrors = [{
    ...(detail.issueCode || ISSUE_CODES[reason] ? { code: detail.issueCode || ISSUE_CODES[reason] } : {}),
    path: `$.sectionResults.${section}`,
    message: `${reason}${detail.limit === undefined ? "" : ` (limit=${detail.limit}, actual=${detail.actual})`}`,
    meta: { section, ...detail },
  }];
  throw error;
}

function locateWriteError(error, section, changeIndex) {
  if (error?.code !== "MEMORY_WRITE_GUARD_INVALID") return error;
  const defaultField = {
    text_length_exceeded: "text", append_length_exceeded: "text", duplicate_item: "text",
    source_limit_exceeded: "evidenceMessageIds", item_not_found: "ref",
  }[error.reason];
  error.validationErrors = error.validationErrors.map(issue => ({ ...issue,
    path: `$.sectionResults.${section}.changes[${changeIndex}]${issue.meta?.field || defaultField ? `.${issue.meta?.field || defaultField}` : ""}`,
  }));
  return error;
}

function assertItemLimits(section, text, sourceRefs, task) {
  const limits = sectionLimits(section, task);
  const chars = codePointLength(text);
  if (chars > limits.maxItemChars) rejectWrite("text_length_exceeded", section, { limit: limits.maxItemChars, actual: chars });
  if (sourceRefs.length > limits.maxSourceRefs) rejectWrite("source_limit_exceeded", section, { limit: limits.maxSourceRefs, actual: sourceRefs.length });
}

module.exports = { rejectWrite, assertItemLimits, locateWriteError };
