const crypto = require("crypto");

const IGNORED_PREFIXES = ["/uploads"];

function normalizeHeader(value, { maxLength = 512 } = {}) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function shouldIgnoreRequest(req) {
  const url = req.originalUrl || "";
  return IGNORED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function createRequestLogger({ logger, logSuccessRequests = false } = {}) {
  if (!logger?.info || !logger?.warn || !logger?.error) {
    throw new Error("Request logger requires a logger adapter");
  }

  return function requestLogger(req, res, next) {
    const incomingId = req.headers["x-request-id"];
    const requestId = typeof incomingId === "string" && incomingId.trim()
      ? incomingId.trim()
      : generateRequestId();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      if (shouldIgnoreRequest(req)) return;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const statusCode = res.statusCode || 0;
      if (statusCode < 400 && !logSuccessRequests) return;
      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
      logger[level]("http_request", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        host: normalizeHeader(req.get?.("host") || req.headers.host),
        userAgent: normalizeHeader(req.get?.("user-agent") || req.headers["user-agent"]),
        referer: normalizeHeader(
          req.get?.("referer") || req.get?.("referrer") || req.headers.referer || req.headers.referrer,
          { maxLength: 1024 },
        ),
        xForwardedFor: normalizeHeader(
          req.get?.("x-forwarded-for") || req.headers["x-forwarded-for"],
          { maxLength: 1024 },
        ),
        userId: req.user?.id || null,
      });
    });

    next();
  };
}

module.exports = { createRequestLogger };
