// Reports the last observed request. It never admits, delays, or suppresses work.
function createProviderHealth({ name, now = () => new Date() }) {
  let status = "unknown";
  let reason = null;
  let lastFailureAt = null;
  let lastSuccessAt = null;
  let successCount = 0;
  const snapshot = () => Object.freeze({ name, status, reason, lastFailureAt, lastSuccessAt, successCount });
  return Object.freeze({
    snapshot,
    recordSuccess() {
      status = "healthy"; reason = null; lastSuccessAt = now().toISOString(); successCount++;
      return snapshot();
    },
    recordFailure(error) {
      status = "degraded";
      const httpStatus = Number(error?.status);
      reason = Number.isSafeInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
        ? `http_${httpStatus}` : "request_failed";
      lastFailureAt = now().toISOString();
      return snapshot();
    },
  });
}

module.exports = { createProviderHealth };
