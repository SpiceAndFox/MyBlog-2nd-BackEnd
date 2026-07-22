function readStringEnv(name, defaultValue = "", env = {}) {
  const raw = env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  return trimmed ? trimmed : defaultValue;
}

function readIntEnv(name, defaultValue, env = {}) {
  const raw = env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  if (!trimmed) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readFloatEnv(name, defaultValue, env = {}) {
  const raw = env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  if (!trimmed) return defaultValue;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readBoolEnv(name, defaultValue = false, env = {}) {
  const raw = env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return defaultValue;

  if (["1", "true", "yes", "y", "on"].includes(trimmed)) return true;
  if (["0", "false", "no", "n", "off"].includes(trimmed)) return false;

  return defaultValue;
}

module.exports = {
  readStringEnv,
  readIntEnv,
  readFloatEnv,
  readBoolEnv,
};
