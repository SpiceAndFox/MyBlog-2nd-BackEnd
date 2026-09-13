const { setTimeout: delay } = require("node:timers/promises");

const COVERAGE_PENDING = "CHAT_MEMORY_COVERAGE_PENDING";

function createMemoryReadinessRunner({ scopeCoordinator, memory, timeoutMs, pollIntervalMs = 250,
  onBackgroundError = () => {}, now = () => Date.now(), wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  if (typeof scopeCoordinator?.enqueueSendByKey !== "function") throw new Error("Chat send coordinator is required");
  if (!(timeoutMs > 0) || !(pollIntervalMs > 0)) throw new Error("Memory readiness wait limits must be positive");

  return function run({ key, userId, presetId, signal, execute }) {
    return scopeCoordinator.enqueueSendByKey(key, async ({ signal: sendSignal }) => {
      let waitStartedAt;
      for (;;) {
        sendSignal.throwIfAborted();
        try {
          return await scopeCoordinator.enqueueByKey(key, () => {
            sendSignal.throwIfAborted();
            return execute(sendSignal);
          });
        } catch (error) {
          if (error.code !== COVERAGE_PENDING) throw error;
          sendSignal.throwIfAborted();
          waitStartedAt ??= now();
          const remaining = timeoutMs - (now() - waitStartedAt);
          if (remaining <= 0) {
            error.retryAfterMs = pollIntervalMs;
            throw error;
          }
          // Do not await a provider or recovery barrier while holding Chat's
          // mutation lane. A later attempt captures a fresh state and coverage.
          if (typeof memory.requestContextCatchup !== "function") throw error;
          void Promise.resolve(memory.requestContextCatchup(userId, presetId)).catch(onBackgroundError);
          try { await wait(Math.min(pollIntervalMs, remaining), sendSignal); }
          catch (waitError) { throw sendSignal.aborted ? sendSignal.reason : waitError; }
        }
      }
    }, { cancellable: true, signal });
  };
}

module.exports = { createMemoryReadinessRunner, COVERAGE_PENDING };
