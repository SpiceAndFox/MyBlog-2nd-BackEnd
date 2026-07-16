function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageValue(usage, ...keys) {
  for (const key of keys) {
    const value = finiteNumber(usage?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeUsage(result) {
  const usage = result?.usage;
  const inputTokens = usageValue(usage, "input_tokens", "prompt_tokens");
  const outputTokens = usageValue(usage, "output_tokens", "completion_tokens");
  const cachedInputTokens = usageValue(
    usage,
    "cached_input_tokens",
    "prompt_cache_hit_tokens",
  ) ?? 0;
  const reportedTotal = usageValue(usage, "total_tokens");
  const totalTokens = reportedTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens };
}

function addAggregate(container, key, record) {
  const aggregate = container[key] ?? {
    callCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenUsageMissingCallCount: 0,
  };
  aggregate.callCount += 1;
  if (record.inputTokens === null || record.outputTokens === null) aggregate.tokenUsageMissingCallCount += 1;
  if (record.inputTokens !== null) {
    aggregate.inputTokens += record.inputTokens;
    aggregate.cachedInputTokens += record.cachedInputTokens;
  }
  if (record.outputTokens !== null) aggregate.outputTokens += record.outputTokens;
  if (record.totalTokens !== null) aggregate.totalTokens += record.totalTokens;
  else if (record.inputTokens !== null && record.outputTokens !== null) {
    aggregate.totalTokens += record.inputTokens + record.outputTokens;
  }
  container[key] = aggregate;
}

function createMigrationProviderTelemetry({ expectedModel = null, monotonicNow = () => performance.now() } = {}) {
  const records = [];
  const taskCalls = new Map();

  function record(envelope, result, durationMs, thrown = null, durableAttempt = null) {
    const taskId = String(envelope?.task?.taskId ?? "unknown");
    const taskCallOrdinal = (taskCalls.get(taskId) ?? 0) + 1;
    taskCalls.set(taskId, taskCallOrdinal);
    const usage = normalizeUsage(result);
    records.push(Object.freeze({
      targetKey: String(envelope?.task?.targetKey ?? "unknown"),
      proposer: String(envelope?.task?.proposer ?? "unknown"),
      taskMode: String(envelope?.task?.mode ?? "normal"),
      model: String(result?.model ?? expectedModel ?? "unknown"),
      result: thrown ? "thrown" : result?.status === "error" ? String(result.reason || "error") : String(result?.status || "unknown"),
      taskCallOrdinal,
      durableAttempt,
      durationMs: Math.max(0, Number(durationMs) || 0),
      ...usage,
    }));
  }

  function wrapAdapter(adapter, { loadTaskAttempt = null } = {}) {
    if (!adapter?.propose) throw new Error("Migration Provider adapter is required");
    return Object.freeze({
      async propose(envelope, options) {
        let durableAttempt = null;
        if (typeof loadTaskAttempt === "function") {
          try {
            const value = Number(await loadTaskAttempt(envelope));
            if (Number.isSafeInteger(value) && value >= 0) durableAttempt = value;
          } catch {
            // Missing audit context is reported as incomplete coverage without
            // changing Provider execution or migration correctness.
          }
        }
        const started = monotonicNow();
        try {
          const result = await adapter.propose(envelope, options);
          record(envelope, result, monotonicNow() - started, null, durableAttempt);
          return result;
        } catch (error) {
          record(envelope, null, monotonicNow() - started, error, durableAttempt);
          throw error;
        }
      },
    });
  }

  function mark() { return records.length; }

  function snapshot(since = 0) {
    const selected = records.slice(since);
    const byTarget = {};
    const byProposer = {};
    const byModel = {};
    const byMode = {};
    const byResult = {};
    let durationMs = 0;
    let retryCallCount = 0;
    let retryClassificationMissingCallCount = 0;
    for (const entry of selected) {
      addAggregate(byTarget, entry.targetKey, entry);
      addAggregate(byProposer, entry.proposer, entry);
      addAggregate(byModel, entry.model, entry);
      addAggregate(byMode, entry.taskMode, entry);
      addAggregate(byResult, entry.result, entry);
      durationMs += entry.durationMs;
      if (entry.durableAttempt === null) retryClassificationMissingCallCount += 1;
      if ((entry.durableAttempt ?? 0) > 0 || entry.taskCallOrdinal > 1) retryCallCount += 1;
    }
    const totals = {};
    for (const entry of selected) addAggregate(totals, "all", entry);
    const summary = totals.all ?? {
      callCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      totalTokens: 0, tokenUsageMissingCallCount: 0,
    };
    return {
      ...summary,
      retryCallCount,
      retryClassificationMissingCallCount,
      retryClassificationCoverageComplete: retryClassificationMissingCallCount === 0,
      providerDurationMs: Math.max(0, Math.round(durationMs)),
      tokenUsageCoverageComplete: summary.tokenUsageMissingCallCount === 0,
      byTarget,
      byProposer,
      byModel,
      byMode,
      byResult,
    };
  }

  return Object.freeze({ wrapAdapter, mark, snapshot });
}

module.exports = { createMigrationProviderTelemetry, normalizeUsage };
