function partsAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function assertTimeZone(timeZone) {
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
  catch (error) { throw new Error(`Invalid time zone: ${timeZone}`, { cause: error }); }
}

function representedUtc(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.fractionalSecond || 0,
  );
}

function sameLocalTime(left, right) {
  return ["year", "month", "day", "hour", "minute", "second", "fractionalSecond"]
    .every((key) => (left[key] || 0) === (right[key] || 0));
}

// Temporal-compatible disambiguation without mutating process TZ: choose the
// earlier instant for overlaps and move forward by the transition gap for holes.
function localPartsToInstant(parts, timeZone) {
  assertTimeZone(timeZone);
  const target = representedUtc(parts);
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const instant = target + hours * 60 * 60 * 1000;
    offsets.add(representedUtc(partsAt(instant, timeZone)) - instant);
  }
  const candidates = [...offsets].map((offset) => {
    const instant = target - offset;
    const actual = partsAt(instant, timeZone);
    return { instant, actual, represented: representedUtc(actual) };
  });
  const exact = candidates.filter(({ actual }) => sameLocalTime(actual, parts)).sort((left, right) => left.instant - right.instant);
  if (exact.length) return new Date(exact[0].instant).toISOString();
  const afterGap = candidates.filter(({ represented }) => represented > target).sort((left, right) => (
    left.represented - right.represented || left.instant - right.instant
  ));
  if (afterGap.length) return new Date(afterGap[0].instant).toISOString();
  throw new Error("Local deadline cannot be resolved in the requested time zone");
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
  const boundary = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return localPartsToInstant({
    year: boundary.getUTCFullYear(), month: boundary.getUTCMonth() + 1, day: boundary.getUTCDate(),
    hour: 0, minute: 0, second: 0, fractionalSecond: 0,
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
