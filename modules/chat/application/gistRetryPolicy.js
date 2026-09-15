const TRANSIENT_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function gistRetryDecision(error, attempt, config, now = Date.now()) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  const permanentHttp = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
  const retryable = !permanentHttp && error?.retryable !== false && (
    TRANSIENT_CODES.has(code) || [408, 425, 429].includes(status) || status >= 500 && status <= 599
    || /timeout|timed out/i.test(String(error?.message || ""))
  );
  const retry = retryable && attempt <= config.retryMax;
  const delay = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(30, attempt - 1));
  const retryAfter = Date.parse(error?.retryAfterAt);
  return {
    status: retry ? "retry_wait" : "failed",
    nextRetryAt: retry ? new Date(Math.max(now + delay, Number.isFinite(retryAfter) ? retryAfter : 0)).toISOString() : null,
    reason: Number.isFinite(status) && status > 0 ? `http_${status}` : code || (retryable ? "timeout" : "generation_failed"),
  };
}

module.exports = { gistRetryDecision };
