const crypto = require("crypto");
const { readBoolEnv } = require("../config/readEnv");
const { logger } = require("../logger");

const IGNORED_PREFIXES = ["/uploads"];
const LOG_HTTP_SUCCESS_REQUESTS = readBoolEnv("LOG_HTTP_SUCCESS_REQUESTS", false);

function normalizeHeader(value, { maxLength = 512 } = {}) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function shouldIgnoreRequest(req) {
  const url = req.originalUrl || "";
  return IGNORED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function requestLogger(req, res, next) {
  const incomingId = req.headers["x-request-id"];
  const requestId =
    typeof incomingId === "string" && incomingId.trim() ? incomingId.trim() : generateRequestId();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    if (shouldIgnoreRequest(req)) return;

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const roundedDuration = Math.round(durationMs * 100) / 100;
    const statusCode = res.statusCode || 0;
    if (statusCode < 400 && !LOG_HTTP_SUCCESS_REQUESTS) return;

    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

    const userAgent = normalizeHeader(req.get?.("user-agent") || req.headers["user-agent"]);
    const referer = normalizeHeader(req.get?.("referer") || req.get?.("referrer") || req.headers.referer || req.headers.referrer, {
      maxLength: 1024,
    });
    const host = normalizeHeader(req.get?.("host") || req.headers.host);
    const xForwardedFor = normalizeHeader(req.get?.("x-forwarded-for") || req.headers["x-forwarded-for"], {
      maxLength: 1024,
    });

    logger[level]("http_request", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      durationMs: roundedDuration,
      ip: req.ip,
      host,
      userAgent,
      referer,
      xForwardedFor,
      userId: req.user?.id || null,
    });
  });

  next();
}

module.exports = requestLogger;
