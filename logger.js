const fs = require("fs");
const path = require("path");

const LEVELS = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
});
const DEFAULT_LEVEL = "info";

function resolveLogPath(logDir, rawPath) {
  const normalized = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!normalized) return "";
  return path.isAbsolute(normalized) ? normalized : path.join(logDir, normalized);
}

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function normalizeMeta(meta) {
  if (!meta) return undefined;
  if (meta instanceof Error) return { error: serializeError(meta) };
  if (typeof meta !== "object") return { value: meta };

  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    normalized[key] = value instanceof Error ? serializeError(value) : value;
  }
  return normalized;
}

function buildEntry(level, message, meta) {
  const normalizedMeta = normalizeMeta(meta);
  const entry = { timestamp: new Date().toISOString(), level, message };
  if (normalizedMeta && Object.keys(normalizedMeta).length > 0) entry.meta = normalizedMeta;
  return { entry, normalizedMeta };
}

function safeJsonStringify(value) {
  try { return JSON.stringify(value); }
  catch { return "\"[unserializable]\""; }
}

function emitConsole(level, entry, meta, consoleRef) {
  const metaText = meta ? ` ${safeJsonStringify(meta)}` : "";
  const line = `${entry.timestamp} ${level.toUpperCase()} ${entry.message}${metaText}`;
  if (level === "error") consoleRef.error(line);
  else if (level === "warn") consoleRef.warn(line);
  else if (level === "debug" && consoleRef.debug) consoleRef.debug(line);
  else consoleRef.log(line);
}

function createLogger({ config, baseDir = __dirname, fsRef = fs, consoleRef = console } = {}) {
  if (!config || typeof config !== "object") throw new Error("Logger config is required");
  const configuredLevel = String(config.level || DEFAULT_LEVEL).trim().toLowerCase();
  const activeLevel = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel)
    ? configuredLevel
    : DEFAULT_LEVEL;
  const toConsole = config.toConsole !== false;
  const toFile = config.toFile !== false;
  const logDirValue = String(config.dir || "logs").trim() || "logs";
  const logDir = path.isAbsolute(logDirValue) ? logDirValue : path.join(baseDir, logDirValue);

  if (String(config.nodeEnv || "").trim().toLowerCase() === "production"
    && (config.debugFullEnabled || config.debugGistEnabled)) {
    throw new Error("Raw chat debug logging cannot be enabled in production");
  }

  const levelLogFilePaths = {
    error: resolveLogPath(logDir, config.errorFile || "error.log"),
    warn: resolveLogPath(logDir, config.warnFile || "warn.log"),
    info: resolveLogPath(logDir, config.infoFile || "info.log"),
    debug: resolveLogPath(logDir, config.debugFile || "debug.log"),
  };
  const chatLogFilePath = resolveLogPath(logDir, config.chatFile || "");
  const retained = new Set([...Object.values(levelLogFilePaths), chatLogFilePath].filter(Boolean));
  for (const legacyPath of [
    resolveLogPath(logDir, config.debugFullFile || "debug-full.log"),
    resolveLogPath(logDir, config.debugGistFile || "debug-gist.log"),
  ]) {
    if (!legacyPath || retained.has(legacyPath)) continue;
    try { fsRef.rmSync(legacyPath, { force: true }); }
    catch { /* best-effort startup cleanup */ }
  }
  if (toFile) fsRef.mkdirSync(logDir, { recursive: true });

  function shouldLog(level) {
    return LEVELS[level] <= LEVELS[activeLevel];
  }

  function emitFile(filePath, entry) {
    if (!filePath) return;
    fsRef.appendFile(filePath, `${safeJsonStringify(entry)}\n`, () => {});
  }

  function log(level, message, meta) {
    if (!shouldLog(level)) return;
    const { entry, normalizedMeta } = buildEntry(level, message, meta);
    if (toConsole) emitConsole(level, entry, normalizedMeta, consoleRef);
    if (toFile) emitFile(levelLogFilePaths[level], entry);
  }

  function logChat(message, meta) {
    const { entry, normalizedMeta } = buildEntry("chat", message, meta);
    if (toConsole && shouldLog("info")) emitConsole("chat", entry, normalizedMeta, consoleRef);
    if (toFile) emitFile(chatLogFilePath, entry);
  }

  return Object.freeze({
    log,
    error: (message, meta) => log("error", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    info: (message, meta) => log("info", message, meta),
    chat: logChat,
    debug: (message, meta) => log("debug", message, meta),
  });
}

let configuredLogger = null;

function configureLogger(logger) {
  if (!logger?.error || !logger?.warn || !logger?.info || !logger?.debug) {
    throw new Error("A logger adapter is required");
  }
  configuredLogger = logger;
  return configuredLogger;
}

function getLogger() {
  if (!configuredLogger) {
    throw new Error("Logger is not configured; create it in app/composition before use");
  }
  return configuredLogger;
}

const logger = Object.freeze({
  log(level, message, meta) { return getLogger().log(level, message, meta); },
  error(message, meta) { return getLogger().error(message, meta); },
  warn(message, meta) { return getLogger().warn(message, meta); },
  info(message, meta) { return getLogger().info(message, meta); },
  chat(message, meta) { return getLogger().chat(message, meta); },
  debug(message, meta) { return getLogger().debug(message, meta); },
});

function withRequestContext(req, meta = {}) {
  const context = {};
  if (req) {
    if (req.requestId) context.requestId = req.requestId;
    if (req.method) context.method = req.method;
    if (req.originalUrl) context.path = req.originalUrl;
    if (req.ip) context.ip = req.ip;
    if (req.user?.id) context.userId = req.user.id;
  }
  return { ...context, ...meta };
}

module.exports = {
  logger,
  createLogger,
  configureLogger,
  getLogger,
  withRequestContext,
};
