const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);
const TRANSIENT_CODES = new Set([
  "MEMORY_PROVIDER_TIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const PERMANENT_CODES = new Set([
  "MEMORY_PROVIDER_INPUT_LIMIT", "MEMORY_PROVIDER_OUTPUT_LIMIT", "INVALID_API_KEY",
  "MODEL_NOT_FOUND", "UNSUPPORTED_MODEL", "UNSUPPORTED_PROVIDER", "INVALID_REQUEST",
]);
const BOUNDED_REASONS = new Set(["safety_policy_blocked", "max_output_truncated"]);

// Tasks and foreground projection recovery share the same error classification.
// An unknown exception is bounded, rather than silently treated as an unlimited outage.
function classifyMemoryProviderFailure(result = {}) {
  const reason = result.reason || "llm_call_failed";
  const detail = result.detail || result;
  const code = String(detail.code || "").toUpperCase();
  const status = Number(detail.status);
  if (reason === "provider_queue_full") return { kind: "transient", retryable: true, reason };
  if (BOUNDED_REASONS.has(reason)) return { kind: "bounded", retryable: true, reason };
  if (reason !== "llm_call_failed") return { kind: "permanent", retryable: false, reason };
  if (detail.retryable === false || PERMANENT_CODES.has(code) || PERMANENT_HTTP_STATUSES.has(status)) {
    return { reason, kind: "permanent", retryable: false };
  }
  const transient = detail.retryable === true || TRANSIENT_CODES.has(code)
    || [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
  return { reason, kind: transient ? "transient" : "bounded", retryable: true };
}

function providerBackoffMs(config, failures) {
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * (2 ** Math.min(30, Math.max(0, failures - 1))));
}

function providerFailureDecision({ counters, result, config, retryMax, consecutiveErrors = 0, haltAfter = Infinity, now }) {
  const classification = classifyMemoryProviderFailure(result);
  const transient = classification.kind === "transient";
  const field = transient ? "transientFailures" : "boundedFailures";
  counters[field] += 1;
  const budgetExhausted = classification.retryable
    && counters[field] > (transient ? config.transientRetryMax : retryMax);
  const correctnessHalt = !transient && consecutiveErrors >= haltAfter;
  const exhausted = !classification.retryable || budgetExhausted || correctnessHalt;
  const retryAfter = Date.parse(result.detail?.retryAfterAt);
  const notBefore = exhausted ? null : new Date(Math.max(
    now.getTime() + providerBackoffMs(config, counters[field]),
    Number.isFinite(retryAfter) ? retryAfter : 0,
  )).toISOString();
  return { kind: classification.kind, counters, halted: exhausted, notBefore, budgetExhausted };
}

module.exports = { classifyMemoryProviderFailure, providerBackoffMs, providerFailureDecision };
