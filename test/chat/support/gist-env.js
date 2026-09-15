function gistTestEnvironment() {
  return {
    CHAT_GIST_POLL_INTERVAL_MS: "700",
    CHAT_GIST_LEASE_GRACE_MS: "900",
    CHAT_GIST_BACKFILL_MAX_PER_REQUEST: "3",
    CHAT_GIST_RETRY_MAX: "0",
    CHAT_GIST_RETRY_BACKOFF_BASE_MS: "50",
    CHAT_GIST_RETRY_BACKOFF_MAX_MS: "200",
  };
}

module.exports = { gistTestEnvironment };
