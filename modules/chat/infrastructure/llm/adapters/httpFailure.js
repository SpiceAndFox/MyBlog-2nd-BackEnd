function chatHttpFailure(message, response) {
  const retryAfter = response.headers?.get?.("retry-after");
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  const timestamp = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);
  return Object.assign(new Error(message), { status: response.status,
    retryAfterAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null });
}

module.exports = { chatHttpFailure };
