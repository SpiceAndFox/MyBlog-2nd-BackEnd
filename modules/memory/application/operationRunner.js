const { setTimeout: sleep } = require("node:timers/promises");

const SUCCESS = new Set(["completed", "committed", "noop", "prepared", "capacity_deferred", "compaction_applied", "capacity_resolved", "healthy"]);

// Examine every member of a wave: a retryable first member must not hide a halted sibling.
function operationWait(result) {
  const deadlines = [];
  let stopped = false;
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.halted || ["failed", "halted", "stale", "cancelled", "interrupted"].includes(node.status)) {
      stopped = true;
      return;
    }
    const deadline = node.notBefore ? new Date(node.notBefore).getTime() : NaN;
    const waiting = (node.status === "retry_wait" || (node.status === "error" && node.halted === false)) && Number.isFinite(deadline);
    if (waiting) {
      deadlines.push(deadline);
    }
    const children = [node.result, node.barrier, ...(node.results || [])].filter(Boolean);
    if (children.length) children.forEach(visit);
    else if (!waiting && !SUCCESS.has(node.status)) stopped = true;
  }
  visit(result);
  return !stopped && deadlines.length ? { notBefore: new Date(Math.max(...deadlines)).toISOString() } : null;
}

function summarizeOperation(result) {
  if (!result || typeof result !== "object") return null;
  const summary = Object.fromEntries(["status", "outcome", "reason", "taskId", "targetKey", "sourceGeneration", "boundaryMessageId",
    "notBefore", "halted", "attempt", "consecutiveErrors", "recoveryKind", "waitCount", "totalWaitCount", "stage", "mode"]
    .filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  if (result.result) summary.result = summarizeOperation(result.result);
  if (result.barrier) summary.barrier = summarizeOperation(result.barrier);
  if (result.results?.length) summary.results = result.results.map(summarizeOperation);
  if (result.detail) summary.provider = Object.fromEntries(["status", "code", "retryable", "retryAfterAt"]
    .filter(key => result.detail[key] !== undefined).map(key => [key, result.detail[key]]));
  return summary;
}

function createOperationRunner({ now = () => Date.now(), sleepUntilNext = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  async function run({ step, readProgress = async () => null, signal, onWait, scope, phase } = {}) {
    let progress = JSON.stringify(await readProgress());
    let lastResult = null;
    let waitCount = 0;
    let totalWaitCount = 0;
    let waiting = null;
    const emit = event => onWait?.({ event, scope, phase, ...waiting, result: lastResult, waitCount, totalWaitCount });
    const observeProgress = async () => {
      const next = JSON.stringify(await readProgress());
      if (next !== progress) {
        progress = next;
        if (waitCount > 0) emit("memory_progress_resumed");
        waitCount = 0;
      }
    };
    const paused = () => ({ status: "interrupted", reason: "cancelled", result: lastResult, waitCount, totalWaitCount });
    while (true) {
      if (signal?.aborted) return paused();
      lastResult = await step();
      await observeProgress();
      if (["completed", "healthy"].includes(lastResult.status)) return { ...lastResult, waitCount, totalWaitCount };
      if (signal?.aborted) return paused();
      waiting = operationWait(lastResult);
      if (!waiting) return { ...lastResult, waitCount, totalWaitCount };
      waitCount += 1;
      totalWaitCount += 1;
      emit("memory_waiting");
      const deadline = Date.parse(waiting.notBefore);
      const wakeAt = deadline <= now() ? now() + 1000 : deadline;
      // Wake in small pieces to observe cancellation/progress without re-dispatching the provider.
      while (true) {
        if (signal?.aborted) return paused();
        await observeProgress();
        const delay = wakeAt - now();
        if (delay <= 0) break;
        try { await sleepUntilNext(Math.min(delay, 1000), signal); }
        catch (error) { if (signal?.aborted) return paused(); throw error; }
      }
      emit("memory_wait_finished");
    }
  }
  return Object.freeze({ run });
}

module.exports = { createOperationRunner, operationWait, summarizeOperation };
