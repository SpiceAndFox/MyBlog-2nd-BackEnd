function normalizeIanaTimeZone(value) {
  const timeZone = String(value ?? "").trim();
  if (!timeZone) throw new Error("Time zone cannot be empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch (error) {
    throw new Error(`Invalid IANA time zone: ${timeZone}`, { cause: error });
  }
  return timeZone;
}

function isValidIanaTimeZone(value) {
  try { normalizeIanaTimeZone(value); return true; }
  catch { return false; }
}

module.exports = { normalizeIanaTimeZone, isValidIanaTimeZone };
