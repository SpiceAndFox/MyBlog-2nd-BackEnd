const { buildRepairPlan, expectedShape } = require("./buildRepairPlan");
const { classifyIssues, inferIssueCode, summarizeOutputShape, valueType } = require("./classifyIssues");
const { normalizeSemanticOutput } = require("./normalizeOutput");
const {
  ISSUE_CODES,
  OUTPUT_REPAIR_POLICY_VERSION,
  REJECTED_OUTPUT_MAX_BYTES,
  SAFE_NORMALIZATIONS,
} = require("./policy");
const { isFlatWireProposer } = require("../../contracts/flatWire");
const { usesTodoWireProtocol } = require("../../contracts/outputProtocol");
const { renderRepairInstruction, renderRepairMessage } = require("./renderRepairInstruction");

function createRepairFeedback(detail = {}, attempt = 0, task = null) {
  const safeDetail = detail && typeof detail === "object" ? detail : {};
  const transportIssue = {
    content_incomplete_json: {
      code: ISSUE_CODES.STRUCTURED_OUTPUT_INCOMPLETE,
      path: "$",
      message: "previous structured output ended before JSON was complete",
    },
    tool_arguments_incomplete_json: {
      code: ISSUE_CODES.STRUCTURED_OUTPUT_INCOMPLETE,
      path: "$",
      message: "previous structured output ended before JSON was complete",
    },
    content_invalid_json: {
      code: ISSUE_CODES.TOOL_ARGUMENTS_INVALID_JSON,
      path: "$",
      message: "previous tool arguments are not valid JSON",
    },
    tool_arguments_invalid_json: {
      code: ISSUE_CODES.TOOL_ARGUMENTS_INVALID_JSON,
      path: "$",
      message: "previous tool arguments are not valid JSON",
    },
    content_missing: {
      code: ISSUE_CODES.STRUCTURED_OUTPUT_MISSING,
      path: "$",
      message: "structured tool arguments are missing",
    },
    tool_call_missing: {
      code: ISSUE_CODES.STRUCTURED_OUTPUT_MISSING,
      path: "$",
      message: "structured tool arguments are missing",
    },
  }[safeDetail.transportError];
  const errors = classifyIssues([
    ...(transportIssue ? [transportIssue] : []),
    ...(Array.isArray(safeDetail.errors) ? safeDetail.errors : []),
  ], { usesFlatWire: isFlatWireProposer(task?.proposer), usesTodoWireProtocol: usesTodoWireProtocol(task) });
  if (!errors.length) {
    errors.push({
      code: ISSUE_CODES.CONTRACT_INVALID,
      path: "$",
      message: "does not satisfy the local output contract",
    });
  }
  const specialist = typeof safeDetail.specialist === "string" && safeDetail.specialist ? safeDetail.specialist : null;
  return {
    policyVersion: OUTPUT_REPAIR_POLICY_VERSION,
    attempt,
    ...(["business", "semantic", "wire_schema", "transport"].includes(safeDetail.validationLayer)
      ? { validationLayer: safeDetail.validationLayer } : {}),
    ...(specialist ? { specialist } : {}),
    errors,
    plan: buildRepairPlan({ errors, specialist, task }),
  };
}

const TRANSPORT_REPAIR_ERRORS = new Set([
  "content_incomplete_json",
  "tool_arguments_incomplete_json",
  "content_invalid_json",
  "tool_arguments_invalid_json",
  "content_missing",
  "tool_call_missing",
]);

function isTransportRepairFailure(detail) {
  return TRANSPORT_REPAIR_ERRORS.has(detail?.transportError);
}

function repairAttemptCount(stagePayload) {
  // Monotonic repair history numbering, independent of execution allowances.
  return Math.max(Number(stagePayload?.schemaRepairFeedback?.attempt || 0),
    Number(stagePayload?.schemaInvalidAttempts || 0) + Number(stagePayload?.transportInvalidAttempts || 0),
    ...(stagePayload?.schemaRejectedOutputs || []).map(entry => Number(entry.attempt) + 1));
}

function captureRejectedOutput(value) {
  if (value === undefined) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { available: false, reason: "not_json_serializable" };
  }
  if (serialized === undefined) return null;
  const utf8Bytes = Buffer.byteLength(serialized, "utf8");
  if (utf8Bytes > REJECTED_OUTPUT_MAX_BYTES) {
    return { available: false, reason: "size_limit", utf8Bytes };
  }
  return {
    available: true,
    utf8Bytes,
    output: JSON.parse(serialized),
  };
}

function appendRejectedOutputAttempt(stagePayload, adapterResult, attempt, maxEntries) {
  const next = structuredClone(stagePayload || {});
  const captured = captureRejectedOutput(adapterResult?.rejectedOutput)
    || (adapterResult?.rejectedOutputKind === "unavailable" ? { available: false, reason: "unavailable" } : null);
  if (!captured) return next;
  const entry = {
    attempt,
    ...(adapterResult?.rejectedOutputKind ? { outputKind: adapterResult.rejectedOutputKind } : {}),
    ...(adapterResult?.protocol ? { protocol: structuredClone(adapterResult.protocol) } : {}),
    ...(adapterResult?.detail?.specialist ? { specialist: adapterResult.detail.specialist } : {}),
    ...captured,
  };
  const entries = Array.isArray(next.schemaRejectedOutputs)
    ? next.schemaRejectedOutputs.slice()
    : [];
  const existing = entries.findIndex((value) => (
    Number(value?.attempt) === attempt
    && String(value?.specialist || "") === String(entry.specialist || "")
  ));
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  next.schemaRejectedOutputs = entries.slice(-Math.max(1, Number(maxEntries) || 1));
  return next;
}

function latestRejectedOutput(stagePayload, feedback = null) {
  const entries = Array.isArray(stagePayload?.schemaRejectedOutputs)
    ? stagePayload.schemaRejectedOutputs
    : [];
  const specialist = feedback?.specialist || null;
  const selected = [...entries].reverse().find((entry) => (
    !specialist || entry.specialist === specialist
  ));
  // Never replay an older candidate against feedback for an unavailable one.
  return selected?.available === true ? selected.output : undefined;
}

function repairContextForInput(stagePayload, inputVariant = "base") {
  const feedback = stagePayload?.schemaRepairFeedback;
  // Old feedback has no input binding. It remains usable for the base window,
  // but must not be assumed to describe a later expanded invocation.
  const repairFeedback = feedback && (feedback.inputVariant ?? "base") === inputVariant ? feedback : null;
  return { repairFeedback, rejectedOutput: repairFeedback ? latestRejectedOutput(stagePayload, repairFeedback) : undefined };
}

module.exports = {
  ISSUE_CODES,
  OUTPUT_REPAIR_POLICY_VERSION,
  REJECTED_OUTPUT_MAX_BYTES,
  SAFE_NORMALIZATIONS,
  appendRejectedOutputAttempt,
  buildRepairPlan,
  captureRejectedOutput,
  classifyIssues,
  createRepairFeedback,
  expectedShape,
  inferIssueCode,
  isTransportRepairFailure,
  latestRejectedOutput,
  normalizeSemanticOutput,
  renderRepairInstruction,
  renderRepairMessage,
  repairAttemptCount,
  repairContextForInput,
  summarizeOutputShape,
  valueType,
};
