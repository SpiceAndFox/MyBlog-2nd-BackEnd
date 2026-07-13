const { chatTimeContextConfig } = require("../../../../config");
const { isTimeQuery } = require("../isTimeQuery");

const TIME_CONTEXT_TIME_ZONE = chatTimeContextConfig.timeZone;
const TIME_CONTEXT_TEMPLATE = chatTimeContextConfig.template;
const TIME_CONTEXT_USER_TEMPLATE = chatTimeContextConfig.userTemplate;

let timeContextDateTimeFormatter = null;
function getTimeContextDateTimeFormatter() {
  if (timeContextDateTimeFormatter) return timeContextDateTimeFormatter;
  timeContextDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_CONTEXT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return timeContextDateTimeFormatter;
}

function formatDateTimeMs(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";

  const parts = getTimeContextDateTimeFormatter().formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  if (!year || !month || !day || !hour || !minute || !second) return "";

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

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
  return String(value || "")
    .split("\\n")
    .join("\n");
}

function renderTemplate(rawTemplate, vars) {
  let rendered = String(rawTemplate || "");
  const entries = vars && typeof vars === "object" && !Array.isArray(vars) ? Object.entries(vars) : [];
  for (const [key, rawValue] of entries) {
    const token = `{{${String(key)}}}`;
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue);
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

function readCurrentUserMessageContent({ recent } = {}) {
  const messages = Array.isArray(recent?.messages) ? recent.messages : [];
  if (!messages.length) return "";
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  return String(last.content || "");
}

function buildTimeContextSegment({ timeContext, recent } = {}) {
  if (!chatTimeContextConfig.enabled) return null;

  const nowMs = Number(timeContext?.nowMs);
  if (!Number.isFinite(nowMs)) throw new Error("Invalid timeContext.nowMs");

  const lastMs = timeContext?.lastMs === null ? null : Number(timeContext?.lastMs);
  if (lastMs !== null && !Number.isFinite(lastMs)) throw new Error("Invalid timeContext.lastMs");

  const gapMs = timeContext?.gapMs === null ? null : Number(timeContext?.gapMs);
  if (gapMs !== null && !Number.isFinite(gapMs)) throw new Error("Invalid timeContext.gapMs");

  const nowText = formatDateTimeMs(nowMs);
  const lastText = lastMs === null ? "" : formatDateTimeMs(lastMs);
  const gapHuman = gapMs === null ? "" : formatGapHuman(gapMs);

  const gapSeconds = gapMs === null ? "" : Math.floor(gapMs / 1000);
  const gapMinutes = gapMs === null ? "" : Math.floor(gapMs / (60 * 1000));
  const gapHours = gapMs === null ? "" : Math.floor(gapMs / (60 * 60 * 1000));
  const gapDays = gapMs === null ? "" : Math.floor(gapMs / (24 * 60 * 60 * 1000));

  const vars = {
    time_zone: TIME_CONTEXT_TIME_ZONE,
    now: nowText,
    last: lastText,
    gap_ms: gapMs === null ? "" : gapMs,
    gap_seconds: gapSeconds,
    gap_minutes: gapMinutes,
    gap_hours: gapHours,
    gap_days: gapDays,
    gap_human: gapHuman,
  };

  const template = normalizeTemplate(TIME_CONTEXT_TEMPLATE);
  const systemContent = renderTemplate(template, vars).trim();
  const currentUserContent = readCurrentUserMessageContent({ recent });
  const messages = [];

  // timeContext 只作为 system 上下文注入；复制为 user 消息会扰乱当前消息边界。
  // if (isTimeQuery(currentUserContent)) {
  //   const userTemplate = normalizeTemplate(TIME_CONTEXT_USER_TEMPLATE);
  //   const userContent = renderTemplate(userTemplate, vars).trim();
  //   if (userContent) {
  //     messages.push({ role: "user", content: userContent });
  //   }
  // } else if (systemContent) {
  //   messages.push({ role: "system", content: systemContent });
  // }

  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  if (!messages.length) return null;
  return { messages };
}

module.exports = {
  buildTimeContextSegment,
};
