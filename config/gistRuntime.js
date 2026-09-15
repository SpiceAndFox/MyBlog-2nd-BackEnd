// Scheduling and recovery policy must be explicitly configured by the environment.
function readInteger(env, name, minimum) {
  const raw = env[name];
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`Missing required env: ${name}`);
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Env ${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function loadGistRuntimeConfig(env) {
  const retry = {
    retryMax: readInteger(env, "CHAT_GIST_RETRY_MAX", 0),
    backoffBaseMs: readInteger(env, "CHAT_GIST_RETRY_BACKOFF_BASE_MS", 1),
    backoffMaxMs: readInteger(env, "CHAT_GIST_RETRY_BACKOFF_MAX_MS", 1),
  };
  if (retry.backoffMaxMs < retry.backoffBaseMs)
    throw new Error("CHAT_GIST_RETRY_BACKOFF_MAX_MS must be >= CHAT_GIST_RETRY_BACKOFF_BASE_MS");
  return Object.freeze({
    pollIntervalMs: readInteger(env, "CHAT_GIST_POLL_INTERVAL_MS", 1),
    leaseGraceMs: readInteger(env, "CHAT_GIST_LEASE_GRACE_MS", 1),
    backfillMaxPerRequest: readInteger(env, "CHAT_GIST_BACKFILL_MAX_PER_REQUEST", 1),
    retry: Object.freeze(retry),
  });
}

module.exports = { loadGistRuntimeConfig };
