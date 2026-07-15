function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function roundUsd(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function normalizePricing(pricing, expectedModel) {
  if (!pricing) return null;
  const requiredString = (name) => {
    const value = String(pricing[name] ?? "").trim();
    if (!value) throw new Error(`Migration pricing ${name} is required`);
    return value;
  };
  const requiredRate = (name) => {
    const value = finiteNumber(pricing[name]);
    if (value === null) throw new Error(`Migration pricing ${name} must be a non-negative number`);
    return value;
  };
  const normalized = Object.freeze({
    version: requiredString("version"),
    source: requiredString("source"),
    effectiveAt: requiredString("effectiveAt"),
    currency: requiredString("currency").toUpperCase(),
    model: requiredString("model"),
    inputUsdPerMillionTokens: requiredRate("inputUsdPerMillionTokens"),
    cachedInputUsdPerMillionTokens: requiredRate("cachedInputUsdPerMillionTokens"),
    outputUsdPerMillionTokens: requiredRate("outputUsdPerMillionTokens"),
  });
  if (normalized.currency !== "USD") throw new Error("Migration pricing currency must be USD");
  if (expectedModel && normalized.model !== expectedModel) {
    throw new Error(`Migration pricing model ${normalized.model} does not match configured model ${expectedModel}`);
  }
  if (!Number.isFinite(Date.parse(normalized.effectiveAt))) {
    throw new Error("Migration pricing effectiveAt must be an ISO-compatible timestamp");
  }
  return normalized;
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
  const providerReportedCostUsd = usageValue(usage, "cost_usd", "cost")
    ?? finiteNumber(result?.costUsd)
    ?? finiteNumber(result?.cost);
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens, providerReportedCostUsd };
}

function calculateCost(usage, pricing) {
  if (usage.providerReportedCostUsd !== null) {
    return { costUsd: usage.providerReportedCostUsd, costSource: "provider_reported" };
  }
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) {
    return { costUsd: null, costSource: null };
  }
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const costUsd = (
    (uncached * pricing.inputUsdPerMillionTokens)
    + (cached * pricing.cachedInputUsdPerMillionTokens)
    + (usage.outputTokens * pricing.outputUsdPerMillionTokens)
  ) / 1_000_000;
  return { costUsd: roundUsd(costUsd), costSource: `pricing:${pricing.version}` };
}

function addAggregate(container, key, record) {
  const aggregate = container[key] ?? {
    callCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    tokenUsageMissingCallCount: 0,
    costMissingCallCount: 0,
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
  if (record.costUsd === null) aggregate.costMissingCallCount += 1;
  else aggregate.costUsd = roundUsd(aggregate.costUsd + record.costUsd);
  container[key] = aggregate;
}

function createMigrationProviderTelemetry({ pricing = null, expectedModel = null, monotonicNow = () => performance.now() } = {}) {
  const normalizedPricing = normalizePricing(pricing, expectedModel);
  const records = [];
  const taskCalls = new Map();

  function record(envelope, result, durationMs, thrown = null, durableAttempt = null) {
    const taskId = String(envelope?.task?.taskId ?? "unknown");
    const taskCallOrdinal = (taskCalls.get(taskId) ?? 0) + 1;
    taskCalls.set(taskId, taskCallOrdinal);
    const usage = normalizeUsage(result);
    const cost = calculateCost(usage, normalizedPricing);
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
      ...cost,
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
      totalTokens: 0, costUsd: 0, tokenUsageMissingCallCount: 0, costMissingCallCount: 0,
    };
    return {
      ...summary,
      retryCallCount,
      retryClassificationMissingCallCount,
      retryClassificationCoverageComplete: retryClassificationMissingCallCount === 0,
      providerDurationMs: Math.max(0, Math.round(durationMs)),
      tokenUsageCoverageComplete: summary.tokenUsageMissingCallCount === 0,
      costCoverageComplete: summary.costMissingCallCount === 0,
      pricing: normalizedPricing,
      byTarget,
      byProposer,
      byModel,
      byMode,
      byResult,
    };
  }

  return Object.freeze({ wrapAdapter, mark, snapshot, pricing: normalizedPricing });
}

module.exports = { createMigrationProviderTelemetry, normalizePricing, normalizeUsage };
