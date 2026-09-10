const { createHash } = require("node:crypto");

function profileInputHash(envelope) {
  // JSONB may reorder object keys when an envelope is restored. Normalize keys,
  // but preserve array order because message/selector order is part of the input.
  const serialized = JSON.stringify({ task: envelope.task, artifact: envelope.artifact }, (_, value) => (
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
  ));
  return createHash("sha256").update(serialized).digest("hex");
}

function profileRepairBundle(specialistOutputs, inputHash) {
  return { specialistOutputs, ...(inputHash ? { inputHash } : {}) };
}

function profileOutputsForRetry(bundle, inputHash) {
  if (!bundle?.specialistOutputs || typeof bundle.specialistOutputs !== "object" || Array.isArray(bundle.specialistOutputs)) return null;
  // Older task-local bundles have no hash and still undergo bound validation.
  if (bundle.inputHash && bundle.inputHash !== inputHash) return null;
  return bundle.specialistOutputs;
}

function specialistRepairFeedback(feedback, specialist) {
  if (!feedback) return null;
  if (feedback.specialist) return feedback.specialist === specialist.proposer ? feedback : null;
  const errors = Array.isArray(feedback.errors) ? feedback.errors : [];
  const localErrors = errors.filter(issue => issue.meta?.specialist === specialist.proposer
    || issue.meta?.section === specialist.section
    || (!issue.meta?.specialist && !issue.meta?.section));
  return localErrors.length ? { ...feedback, errors: localErrors, specialist: specialist.proposer } : null;
}

module.exports = { profileInputHash, profileRepairBundle, profileOutputsForRetry, specialistRepairFeedback };
