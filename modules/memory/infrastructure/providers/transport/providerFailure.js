function providerTimeoutError() {
  return Object.assign(new Error("Memory Provider request timeout"), { code: "MEMORY_PROVIDER_TIMEOUT", retryable: true });
}

function providerHttpError(response, data, now = Date.now()) {
  const error = new Error(data?.error?.message || `Memory Provider HTTP ${response.status}`);
  error.status = response.status;
  if (typeof data?.error?.code === "string") error.code = data.error.code;
  const value = response.headers?.get?.("retry-after");
  if (value !== undefined && value !== null && String(value).trim()) {
    const seconds = Number(value);
    const deadline = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(value);
    if (Number.isFinite(deadline) && deadline >= 0 && deadline <= 8.64e15) error.retryAfterAt = new Date(deadline).toISOString();
  }
  return error;
}

async function readProviderJson(response) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

module.exports = { providerTimeoutError, providerHttpError, readProviderJson };
