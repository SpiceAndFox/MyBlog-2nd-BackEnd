function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

let attribution = Object.freeze({ siteUrl: "", appName: "" });

function configureOpenRouterAttribution({ siteUrl, appName } = {}) {
  attribution = Object.freeze({
    siteUrl: normalizeOptionalString(siteUrl),
    appName: normalizeOptionalString(appName),
  });
}

function buildOpenRouterAttributionHeaders() {
  const headers = {};

  const siteUrl = attribution.siteUrl;
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;

  const appName = attribution.appName;
  if (appName) headers["X-OpenRouter-Title"] = appName;

  return headers;
}

module.exports = {
  buildOpenRouterAttributionHeaders,
  configureOpenRouterAttribution,
};
