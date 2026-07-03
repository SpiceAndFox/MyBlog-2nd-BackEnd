function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildOpenRouterAttributionHeaders() {
  const headers = {};

  const siteUrl = normalizeOptionalString(process.env.OPENROUTER_SITE_URL);
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;

  const appName = normalizeOptionalString(process.env.OPENROUTER_APP_NAME);
  if (appName) headers["X-OpenRouter-Title"] = appName;

  return headers;
}

module.exports = {
  buildOpenRouterAttributionHeaders,
};
