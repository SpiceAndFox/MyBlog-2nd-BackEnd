// The sole source of operational defaults for gist scheduling and recovery.
const DEFAULTS = Object.freeze({
  pollIntervalMs: 1000,
  leaseGraceMs: 60000,
  backfillMaxPerRequest: 10,
  retryMax: 5,
  backoffBaseMs: 30000,
  backoffMaxMs: 120000,
});

function readInteger(env, name, fallback, minimum) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Env ${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function loadGistRuntimeConfig(env) {
  const retry = {
    retryMax: readInteger(env, "CHAT_GIST_RETRY_MAX", DEFAULTS.retryMax, 0),
    backoffBaseMs: readInteger(env, "CHAT_GIST_RETRY_BACKOFF_BASE_MS", DEFAULTS.backoffBaseMs, 1),
    backoffMaxMs: readInteger(env, "CHAT_GIST_RETRY_BACKOFF_MAX_MS", DEFAULTS.backoffMaxMs, 1),
  };
  if (retry.backoffMaxMs < retry.backoffBaseMs) throw new Error("CHAT_GIST_RETRY_BACKOFF_MAX_MS must be >= CHAT_GIST_RETRY_BACKOFF_BASE_MS");
  return Object.freeze({
    pollIntervalMs: readInteger(env, "CHAT_GIST_POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs, 1),
    leaseGraceMs: readInteger(env, "CHAT_GIST_LEASE_GRACE_MS", DEFAULTS.leaseGraceMs, 1),
    backfillMaxPerRequest: readInteger(env, "CHAT_GIST_BACKFILL_MAX_PER_REQUEST", DEFAULTS.backfillMaxPerRequest, 1),
    retry: Object.freeze(retry),
  });
}

module.exports = { loadGistRuntimeConfig };
