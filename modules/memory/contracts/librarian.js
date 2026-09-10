const {
  LIBRARIAN_PROPOSER,
  LIBRARIAN_SECTIONS,
  LIBRARIAN_TARGET_KEY,
} = require("./constants");
const { sectionLimits, validateWriteLimits } = require("./sectionPolicy");
const { isPlainObject, isIsoTimestamp, CONTENT_HASH_PATTERN } = require("./state");

function issue(path, message) { return { path, message }; }
function text(value) { return typeof value === "string" && value.trim().length > 0; }
function integer(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}
function exactKeys(value, required, optional, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue(path, "must be an object"));
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, "is not allowed"));
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(issue(`${path}.${key}`, "is required"));
  return true;
}
function validateSection(value, path, errors) {
  if (!LIBRARIAN_SECTIONS.includes(value)) errors.push(issue(path, "is not a Librarian section"));
}
function validateTextForSection(value, section, path, errors, task) {
  if (!text(value)) {
    errors.push(issue(path, "must be a non-empty string"));
    return;
  }
  const limit = sectionLimits(section, task)?.maxItemChars;
  if (limit && [...value].length > limit) {
    errors.push(issue(path, `must contain at most ${limit} Unicode characters`));
  }
}
function validateRefs(refs, path, errors, { min = 1 } = {}) {
  if (!Array.isArray(refs) || refs.length < min) {
    errors.push(issue(path, `must contain at least ${min} short ref(s)`));
    return;
  }
  refs.forEach((ref, index) => { if (!text(ref)) errors.push(issue(`${path}[${index}]`, "must be a non-empty short ref")); });
  if (new Set(refs).size !== refs.length) errors.push(issue(path, "must not contain duplicates"));
}

function validateLibrarianArtifact(artifact) {
  const errors = [];
  if (!exactKeys(artifact, ["publicInput", "refMap", "messageMeta"], [], "$", errors)) return { ok: false, errors };
  if (exactKeys(artifact.publicInput, ["task", "memoryText", "messages"], ["evidenceText"], "$.publicInput", errors)) {
    const task = artifact.publicInput.task;
    const keys = ["taskId", "tickId", "proposer", "targetKey", "targetSections", "boundaryMessageId", "watermarkOrdinal", "watermarkKind", "triggerType", "now", "userTimeZone"];
    if (exactKeys(task, keys, ["writeLimits"], "$.publicInput.task", errors)) {
      errors.push(...validateWriteLimits(task.writeLimits));
      if (!text(task.taskId)) errors.push(issue("$.publicInput.task.taskId", "must be a non-empty string"));
      if (!integer(task.tickId)) errors.push(issue("$.publicInput.task.tickId", "must be a non-negative safe integer"));
      if (task.proposer !== LIBRARIAN_PROPOSER) errors.push(issue("$.publicInput.task.proposer", "must identify the Librarian proposer"));
      if (task.targetKey !== LIBRARIAN_TARGET_KEY) errors.push(issue("$.publicInput.task.targetKey", "must identify the Librarian target"));
      if (JSON.stringify(task.targetSections) !== JSON.stringify(LIBRARIAN_SECTIONS)) errors.push(issue("$.publicInput.task.targetSections", "must exactly cover Librarian sections"));
      if (!integer(task.boundaryMessageId)) errors.push(issue("$.publicInput.task.boundaryMessageId", "must be a non-negative safe integer"));
      if (!integer(task.watermarkOrdinal)) errors.push(issue("$.publicInput.task.watermarkOrdinal", "must be a non-negative safe integer"));
      if (!["complete_turn", "message_batch"].includes(task.watermarkKind)) errors.push(issue("$.publicInput.task.watermarkKind", "is invalid"));
      if (!["periodic", "rebuild", "rebuild_final", "manual"].includes(task.triggerType)) errors.push(issue("$.publicInput.task.triggerType", "is invalid"));
      if (!isIsoTimestamp(task.now)) errors.push(issue("$.publicInput.task.now", "must be an ISO timestamp"));
      if (!text(task.userTimeZone)) errors.push(issue("$.publicInput.task.userTimeZone", "must be a non-empty string"));
    }
    if (artifact.publicInput.evidenceText !== undefined && typeof artifact.publicInput.evidenceText !== "string") errors.push(issue("$.publicInput.evidenceText", "must be a string"));
    if (typeof artifact.publicInput.memoryText !== "string") errors.push(issue("$.publicInput.memoryText", "must be a string"));
    if (!Array.isArray(artifact.publicInput.messages) || artifact.publicInput.messages.length !== 0) errors.push(issue("$.publicInput.messages", "must be an empty array"));
  }
  if (!isPlainObject(artifact.refMap)) errors.push(issue("$.refMap", "must be an object"));
  else {
    if (!isPlainObject(artifact.refMap.writable)) errors.push(issue("$.refMap.writable", "must be an object"));
    if (!isPlainObject(artifact.refMap.readOnly)) errors.push(issue("$.refMap.readOnly", "must be an object"));
    for (const [ref, entry] of Object.entries(artifact.refMap.readOnly || {})) {
      const path = '$.refMap.readOnly.' + ref;
      if (!/^[A-Z][A-Z0-9]*-E[1-9][0-9]*$/.test(ref)) errors.push(issue(path, "must be an evidence alias"));
      if (!exactKeys(entry, ["section", "itemId", "sourceRefs"], [], path, errors)) continue;
      validateSection(entry.section, path + ".section", errors);
      if (!text(entry.itemId) || !Array.isArray(entry.sourceRefs) || entry.sourceRefs.length !== 1
        || !integer(entry.sourceRefs[0]?.messageId, { positive: true }) || !CONTENT_HASH_PATTERN.test(entry.sourceRefs[0]?.contentHash || "")) errors.push(issue(path, "has invalid evidence"));
    }
    for (const [ref, entry] of Object.entries(artifact.refMap.writable || {})) {
      const path = `$.refMap.writable.${ref}`;
      if (!/^[A-Z][A-Z0-9]*$/.test(ref)) errors.push(issue(path, "has an invalid short ref"));
      if (!exactKeys(entry, ["section", "itemId"], [], path, errors)) continue;
      validateSection(entry.section, `${path}.section`, errors);
      if (!text(entry.itemId)) errors.push(issue(`${path}.itemId`, "must be a non-empty item id"));
    }
  }
  if (!isPlainObject(artifact.messageMeta) || Object.keys(artifact.messageMeta).length) errors.push(issue("$.messageMeta", "must be an empty object"));
  return { ok: errors.length === 0, errors };
}

function validateLibrarianSemanticResult(result, taskOrArtifact) {
  const task = taskOrArtifact?.publicInput?.task || taskOrArtifact;
  const artifact = taskOrArtifact?.publicInput ? taskOrArtifact : null;
  const errors = [];
  if (!task || task.proposer !== LIBRARIAN_PROPOSER || task.targetKey !== LIBRARIAN_TARGET_KEY) {
    return { ok: false, errors: [issue("$.task", "does not identify a Librarian task")] };
  }
  if (!exactKeys(result, ["tickId", "proposer", "status", "operations"], ["reports"], "$", errors)) return { ok: false, errors };
  if (result.tickId !== task.tickId) errors.push(issue("$.tickId", "does not match task"));
  if (result.proposer !== LIBRARIAN_PROPOSER) errors.push(issue("$.proposer", "does not match task"));
  if (!["changes", "noop"].includes(result.status)) errors.push(issue("$.status", "is invalid"));
  if (result.reports !== undefined) {
    if (!Array.isArray(result.reports) || result.reports.length > 6) errors.push(issue("$.reports", "must contain at most six reports"));
    else result.reports.forEach((report, index) => {
      const path = '$.reports[' + index + ']';
      if (!exactKeys(report, ["ref", "reason"], [], path, errors)) return;
      if (!text(report.ref) || (artifact && !artifact.refMap.writable[report.ref])) errors.push(issue(path + ".ref", "must be a writable ref"));
      if (!["unsupported_section", "insufficient_evidence", "cannot_repair"].includes(report.reason)) errors.push(issue(path + ".reason", "is invalid"));
    });
  }
  if (Array.isArray(result.operations) && result.operations.length > 6) errors.push(issue("$.operations", "must contain at most six operations"));
  if (result.status === "noop") {
    if (!Array.isArray(result.operations) || result.operations.length !== 0) errors.push(issue("$.operations", "must be an empty array when status is noop"));
    return { ok: errors.length === 0, errors };
  }
  if (!Array.isArray(result.operations) || result.operations.length === 0) {
    errors.push(issue("$.operations", "must be a non-empty array"));
    return { ok: false, errors };
  }
  const usedRefs = new Set();
  const rendered = artifact?.refMap?.writable;
  const participate = (ref, path) => {
    if (!text(ref)) errors.push(issue(path, "must be a non-empty short ref"));
    else {
      if (rendered && !rendered[ref]) errors.push(issue(path, `ref ${ref} was not rendered as writable Memory`));
      if (usedRefs.has(ref)) errors.push(issue(path, `ref ${ref} participates in more than one top-level operation`));
      usedRefs.add(ref);
    }
  };
  const evidence = (refs, path) => {
    validateRefs(refs, path, errors);
    if (artifact && Array.isArray(refs)) for (const ref of refs) {
      if (!artifact.refMap.readOnly[ref]) errors.push(issue(path, "evidence ref was not rendered: " + ref));
    }
  };
  result.operations.forEach((operation, index) => {
    const path = `$.operations[${index}]`;
    if (!isPlainObject(operation)) {
      errors.push(issue(path, "must be an object"));
      return;
    }
    if (operation.action === "move") {
      if (!exactKeys(operation, ["action", "ref", "toSection"], [], path, errors)) return;
      participate(operation.ref, `${path}.ref`);
      validateSection(operation.toSection, `${path}.toSection`, errors);
      if (rendered?.[operation.ref]?.section === operation.toSection) errors.push(issue(`${path}.toSection`, "must differ from the source section"));
    } else if (operation.action === "merge") {
      if (!exactKeys(operation, ["action", "refs", "toSection", "text", "supportRefs"], [], path, errors)) return;
      validateRefs(operation.refs, `${path}.refs`, errors, { min: 2 });
      for (const ref of operation.refs || []) participate(ref, `${path}.refs`);
      validateSection(operation.toSection, `${path}.toSection`, errors);
      validateTextForSection(operation.text, operation.toSection, `${path}.text`, errors, task);
      evidence(operation.supportRefs, `${path}.supportRefs`);
    } else if (["revise", "correct"].includes(operation.action)) {
      if (!exactKeys(operation, ["action", "ref", "text", "supportRefs"], [], path, errors)) return;
      participate(operation.ref, path + ".ref");
      validateTextForSection(operation.text, rendered?.[operation.ref]?.section, path + ".text", errors, task);
      evidence(operation.supportRefs, path + ".supportRefs");
    } else if (operation.action === "remove") {
      if (!exactKeys(operation, ["action", "ref", "keeperRef", "reason"], [], path, errors)) return;
      participate(operation.ref, path + ".ref");
      participate(operation.keeperRef, path + ".keeperRef");
      if (operation.reason !== "duplicate") errors.push(issue(path + ".reason", "only duplicate removal is supported; report other cases"));
    } else if (operation.action === "split") {
      if (!exactKeys(operation, ["action", "ref", "parts"], [], path, errors)) return;
      participate(operation.ref, `${path}.ref`);
      if (!Array.isArray(operation.parts) || (operation.parts.length < 2 || operation.parts.length > 4)) errors.push(issue(`${path}.parts`, "must contain two to four parts"));
      else {
        operation.parts.forEach((part, partIndex) => {
          const partPath = `${path}.parts[${partIndex}]`;
          if (!exactKeys(part, ["toSection", "text", "supportRefs"], [], partPath, errors)) return;
          validateSection(part.toSection, `${partPath}.toSection`, errors);
          validateTextForSection(part.text, part.toSection, `${partPath}.text`, errors, task);
          evidence(part.supportRefs, `${partPath}.supportRefs`);
        });
      }
    } else errors.push(issue(`${path}.action`, "is invalid"));
  });
  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateLibrarianArtifact,
  validateLibrarianSemanticResult,
};
