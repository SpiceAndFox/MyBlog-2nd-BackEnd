const { ISSUE_CODES } = require("./policy");
const { MAX_VALIDATION_ISSUES } = require("../../contracts/validationIssueCodes");
const { businessRepairRule } = require("./renderBusinessRepair");

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function boundedString(value, fallback = "") {
  return String(value ?? fallback).replace(/[\r\n]+/g, " ").slice(0, 240);
}

function safeIssueMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const safe = {};
  for (const key of ["actualType", "limit", "actual", "section", "messageId", "action", "existingChars", "separatorChars", "maxItemChars",
    "target", "field", "currentStatus", "currentDueAt", "proposedDueAt", "referenceTime", "currentValue", "proposedValue", "reason", "specialist"]) {
    const value = meta[key];
    if (typeof value === "string") safe[key] = boundedString(value).slice(0, 80);
    else if (Number.isSafeInteger(value)) safe[key] = value;
    else if ((value === null || typeof value === "boolean") && ["currentDueAt", "proposedDueAt", "currentValue", "proposedValue"].includes(key)) safe[key] = value;
  }
  if (typeof meta.constraint === "string") safe.constraint = boundedString(meta.constraint);
  if (typeof meta.relatedPath === "string") safe.relatedPath = boundedString(meta.relatedPath).replace(/[^A-Za-z0-9_$.[\]-]/g, "?");
  return Object.keys(safe).length ? safe : null;
}

function inferIssueCode(issue) {
  if (Object.values(ISSUE_CODES).includes(issue?.code)) return issue.code;
  const path = String(issue?.path || "$");
  const message = String(issue?.message || "");
  if (path === "$.sectionResults" && /must be an object/i.test(message)) return ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT;
  if (/must be an object/i.test(message)) return ISSUE_CODES.OBJECT_REQUIRED;
  if (/changes/.test(path) && /non-empty array/i.test(message)) return ISSUE_CODES.CHANGES_EMPTY;
  if (/must include evidenceMessageIds or supportRefs/i.test(message)) return ISSUE_CODES.SOURCE_MISSING;
  if (/rendered as writable Memory/i.test(message)) return ISSUE_CODES.WRITABLE_REF_INVALID;
  if (/rendered as read-only Memory/i.test(message)) return ISSUE_CODES.SUPPORT_REF_INVALID;
  if (/message \d+ was not rendered/i.test(message)) return ISSUE_CODES.EVIDENCE_MESSAGE_INVALID;
  if (/at most \d+ characters/i.test(message)) return ISSUE_CODES.TEXT_LENGTH_EXCEEDED;
  return ISSUE_CODES.CONTRACT_INVALID;
}

function canonicalMessage(code, issue, { usesFlatWire = false, usesTodoWireProtocol = false } = {}) {
  const messages = {
    [ISSUE_CODES.OBJECT_REQUIRED]: "must be an object",
    [ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT]: "sectionResults must be an object",
    [ISSUE_CODES.CHANGES_EMPTY]: "changes must be a non-empty array",
    [ISSUE_CODES.SOURCE_MISSING]: "change must include one allowed source selector",
    [ISSUE_CODES.WRITABLE_REF_INVALID]: "ref must be selected from the bound writable enum",
    [ISSUE_CODES.SUPPORT_REF_INVALID]: "supportRefs must be selected from the bound read-only enum",
    [ISSUE_CODES.EVIDENCE_MESSAGE_INVALID]: "evidenceMessageIds must be selected from the bound message enum",
    [ISSUE_CODES.TEXT_LENGTH_EXCEEDED]: "text must satisfy the section character limit",
    [ISSUE_CODES.TOOL_ARGUMENTS_INVALID_JSON]: "previous tool arguments are not valid JSON",
    [ISSUE_CODES.STRUCTURED_OUTPUT_INCOMPLETE]: "previous structured output ended before JSON was complete",
    [ISSUE_CODES.STRUCTURED_OUTPUT_MISSING]: "structured tool arguments are missing",
  };
  if (usesFlatWire || usesTodoWireProtocol) {
    Object.assign(messages, {
      [ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT]: usesTodoWireProtocol ? "root output must match results.todos" : "root output must match sectionStatuses and changes",
      [ISSUE_CODES.WRITABLE_REF_INVALID]: "target must be selected from the bound writable enum",
      [ISSUE_CODES.SUPPORT_REF_INVALID]: "sources must be selected from the bound source enum",
      [ISSUE_CODES.EVIDENCE_MESSAGE_INVALID]: "sources must be selected from the bound source enum",
    });
  }
  return businessRepairRule(code)?.message || messages[code]
    || boundedString(issue?.message, "does not satisfy the local output contract");
}

function classifyIssues(errors, options = {}) {
  return (Array.isArray(errors) ? errors : []).slice(0, MAX_VALIDATION_ISSUES).map((issue) => {
    const code = inferIssueCode(issue);
    const meta = safeIssueMeta(issue?.meta);
    return {
      code,
      path: boundedString(issue?.path, "$").replace(/[^A-Za-z0-9_$.[\]-]/g, "?"),
      message: canonicalMessage(code, issue, options),
      ...(meta ? { meta } : {}),
    };
  });
}

function summarizeOutputShape(output) {
  const summary = { rootType: valueType(output) };
  if (!output || typeof output !== "object" || Array.isArray(output)) return summary;
  const knownTopLevelKeys = ["operations", "proposer", "sectionResults", "sectionStatuses", "changes", "results", "status", "tickId"];
  const actualTopLevelKeys = Object.keys(output);
  summary.topLevelKeys = knownTopLevelKeys.filter((key) => actualTopLevelKeys.includes(key));
  const unexpectedTopLevelKeyCount = actualTopLevelKeys.length - summary.topLevelKeys.length;
  if (unexpectedTopLevelKeyCount) summary.unexpectedTopLevelKeyCount = unexpectedTopLevelKeyCount;
  if (Object.prototype.hasOwnProperty.call(output, "sectionResults")) summary.sectionResultsType = valueType(output.sectionResults);
  if (Object.prototype.hasOwnProperty.call(output, "operations")) summary.operationsType = valueType(output.operations);
  if (output.sectionResults && typeof output.sectionResults === "object" && !Array.isArray(output.sectionResults)) {
    const knownSections = [
      "assistantProfile",
      "milestones",
      "recentEpisodes",
      "relationship",
      "scene",
      "standingAgreements",
      "todos",
      "userProfile",
      "worldFacts",
    ];
    const actualSectionKeys = Object.keys(output.sectionResults);
    summary.sectionKeys = knownSections.filter((key) => actualSectionKeys.includes(key));
    const unexpectedSectionKeyCount = actualSectionKeys.length - summary.sectionKeys.length;
    if (unexpectedSectionKeyCount) summary.unexpectedSectionKeyCount = unexpectedSectionKeyCount;
  }
  return summary;
}

module.exports = {
  canonicalMessage,
  classifyIssues,
  inferIssueCode,
  safeIssueMeta,
  summarizeOutputShape,
  valueType,
};
