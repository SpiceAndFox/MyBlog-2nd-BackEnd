function formatGapHuman(ms) {
  const gapMs = Number(ms);
  if (!Number.isFinite(gapMs) || gapMs < 0) return "";
  const totalSeconds = Math.floor(gapMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function normalizeTemplate(value) {
  return String(value || "").split("\\n").join("\n");
}

function renderTemplate(rawTemplate, vars) {
  let rendered = String(rawTemplate || "");
  for (const [key, rawValue] of Object.entries(vars || {})) {
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue);
    rendered = rendered.split(`{{${key}}}`).join(value);
  }
  return rendered;
}

function createTimeContextSegment({ enabled, timeZone, template } = {}) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function formatDateTimeMs(ms) {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return "";
    const parts = formatter.formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    if (!["year", "month", "day", "hour", "minute", "second"].every((type) => part(type))) return "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
  }

  return function buildTimeContextSegment({ timeContext } = {}) {
    if (!enabled) return null;
    const nowMs = Number(timeContext?.nowMs);
    if (!Number.isFinite(nowMs)) throw new Error("Invalid timeContext.nowMs");
    const lastMs = timeContext?.lastMs === null ? null : Number(timeContext?.lastMs);
    if (lastMs !== null && !Number.isFinite(lastMs)) throw new Error("Invalid timeContext.lastMs");
    const gapMs = timeContext?.gapMs === null ? null : Number(timeContext?.gapMs);
    if (gapMs !== null && !Number.isFinite(gapMs)) throw new Error("Invalid timeContext.gapMs");
    const content = renderTemplate(normalizeTemplate(template), {
      time_zone: timeZone,
      now: formatDateTimeMs(nowMs),
      last: lastMs === null ? "" : formatDateTimeMs(lastMs),
      gap_ms: gapMs === null ? "" : gapMs,
      gap_seconds: gapMs === null ? "" : Math.floor(gapMs / 1000),
      gap_minutes: gapMs === null ? "" : Math.floor(gapMs / (60 * 1000)),
      gap_hours: gapMs === null ? "" : Math.floor(gapMs / (60 * 60 * 1000)),
      gap_days: gapMs === null ? "" : Math.floor(gapMs / (24 * 60 * 60 * 1000)),
      gap_human: gapMs === null ? "" : formatGapHuman(gapMs),
    }).trim();
    return content ? { messages: [{ role: "system", content }] } : null;
  };
}

module.exports = { createTimeContextSegment };
