// Execution-local allowances. Durable attempts and rejected-output history are
// diagnostics, never an input to a new manual invocation's retry budget.
function createRetryBudget() {
  const entries = new Map();
  function keyForTask(task) {
    // A rebase/replacement of the same logical work must not mint an allowance.
    return JSON.stringify([task.userId, task.presetId, task.sourceGeneration,
      task.targetKey, task.mode || task.taskType || "normal", task.cursorBefore,
      task.targetMessageId ?? task.boundaryMessageId, task.watermarkKind,
      task.mode === "maintenance" ? task.targetSections : null, task.providerLane]);
  }
  function forTask(task) {
    const key = keyForTask(task);
    if (!entries.has(key)) entries.set(key, { transientFailures: 0, boundedFailures: 0,
      transportFailures: 0, schemaFailures: 0 });
    return entries.get(key);
  }
  function providerSucceeded(task) {
    const counts = forTask(task);
    counts.transientFailures = 0;
    counts.boundedFailures = 0;
    if (counts.transportFailures === 0 && counts.schemaFailures === 0) entries.delete(keyForTask(task));
  }
  function outputSucceeded(task) {
    providerSucceeded(task);
    const counts = forTask(task);
    counts.transportFailures = 0;
    counts.schemaFailures = 0;
    entries.delete(keyForTask(task));
  }
  function exhausted(task, config) {
    const counts = forTask(task);
    return counts.transientFailures > config.providerRecovery.transientRetryMax
      || counts.boundedFailures > (task.mode === "maintenance" ? config.compaction.retryMax : config.providerRecovery.retryMax)
      || counts.transportFailures > config.providerRecovery.transportInvalidRetryMax
      || counts.schemaFailures > config.providerRecovery.schemaInvalidRetryMax;
  }
  function resetScope(userId, presetId, targetKey) {
    for (const key of entries.keys()) {
      const [user, preset, , target] = JSON.parse(key);
      if (Number(user) === Number(userId) && preset === presetId && (!targetKey || targetKey === target)) entries.delete(key);
    }
  }
  return Object.freeze({ forTask, exhausted, providerSucceeded, outputSucceeded, resetScope });
}

module.exports = { createRetryBudget };
