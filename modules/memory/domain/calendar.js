function partsAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function assertTimeZone(timeZone) {
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
  catch (error) { throw new Error(`Invalid time zone: ${timeZone}`, { cause: error }); }
}

// Resolve a local wall-clock time to an instant. The bounded search also handles
// non-hour offsets and daylight-saving transitions without process TZ mutation.
function localPartsToInstant(parts, timeZone) {
  assertTimeZone(timeZone);
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsAt(guess, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const next = guess + target - represented;
    if (next === guess) return new Date(guess).toISOString();
    guess = next;
  }
  const final = partsAt(guess, timeZone);
  if (["year", "month", "day", "hour", "minute", "second"].every((key) => final[key] === (parts[key] || 0))) {
    return new Date(guess).toISOString();
  }
  throw new Error("Local deadline falls in an invalid time-zone transition");
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function addCalendarDuration(anchor, duration, timeZone = "UTC") {
  const local = partsAt(anchor, timeZone);
  const years = duration.years || 0;
  const months = duration.months || 0;
  const days = duration.days || 0;
  let year = local.year + years;
  let month = local.month;
  let day = Math.min(local.day, daysInMonth(year, month));
  const monthIndex = year * 12 + (month - 1) + months;
  year = Math.floor(monthIndex / 12);
  month = ((monthIndex % 12) + 12) % 12 + 1;
  day = Math.min(day, daysInMonth(year, month));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return localPartsToInstant({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: local.hour, minute: local.minute, second: local.second,
  }, timeZone);
}

function resolveDueAt(expression, anchor, timeZone = "UTC") {
  if (expression.mode === "relative") return addCalendarDuration(anchor, expression, timeZone);
  const [year, month, day] = expression.date.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  return localPartsToInstant({
    year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(), hour: 0, minute: 0, second: 0,
  }, timeZone);
}

module.exports = { partsAt, localPartsToInstant, addCalendarDuration, resolveDueAt };
