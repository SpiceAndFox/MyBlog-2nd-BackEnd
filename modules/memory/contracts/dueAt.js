const { isPlainObject } = require("./state");

const RELATIVE_DUE_UNITS = Object.freeze({
  days: Object.freeze({ minimum: 0 }),
  months: Object.freeze({ minimum: 1 }),
  years: Object.freeze({ minimum: 1 }),
});
const MESSAGE_ANCHORED_DUE_MODES = Object.freeze(["relative", "dayOfMonth"]);

function dueAtRequiresMessageAnchor(value) {
  return MESSAGE_ANCHORED_DUE_MODES.includes(value?.mode);
}

function validCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateDueAtExpression(value) {
  const errors = [];
  if (!isPlainObject(value) || !["absolute", "relative", "dayOfMonth"].includes(value.mode)) {
    return [{ path: "$", message: "must be an absolute, relative, or dayOfMonth due expression" }];
  }
  if (value.mode === "absolute") {
    const keys = Object.keys(value);
    keys.filter((key) => !["mode", "date"].includes(key)).forEach((key) => errors.push({ path: `$.${key}`, message: "is not allowed" }));
    ["mode", "date"].filter((key) => !Object.prototype.hasOwnProperty.call(value, key)).forEach((key) => errors.push({ path: `$.${key}`, message: "is required" }));
    if (Object.prototype.hasOwnProperty.call(value, "date") && !validCalendarDate(value.date)) {
      errors.push({ path: "$.date", message: "must be a valid YYYY-MM-DD calendar date" });
    }
    return errors;
  }

  if (value.mode === "dayOfMonth") {
    const keys = Object.keys(value);
    keys.filter((key) => !["mode", "day"].includes(key)).forEach((key) => errors.push({ path: `$.${key}`, message: "is not allowed" }));
    ["mode", "day"].filter((key) => !Object.prototype.hasOwnProperty.call(value, key)).forEach((key) => errors.push({ path: `$.${key}`, message: "is required" }));
    if (Object.prototype.hasOwnProperty.call(value, "day")
      && (!Number.isSafeInteger(value.day) || value.day < 1 || value.day > 31)) {
      errors.push({ path: "$.day", message: "must be a safe integer between 1 and 31" });
    }
    return errors;
  }

  const units = Object.keys(RELATIVE_DUE_UNITS);
  const keys = Object.keys(value);
  keys.filter((key) => key !== "mode" && !units.includes(key)).forEach((key) => errors.push({ path: `$.${key}`, message: "is not allowed" }));
  const supplied = units.filter((unit) => Object.prototype.hasOwnProperty.call(value, unit));
  if (supplied.length !== 1) errors.push({ path: "$", message: "relative due expression must contain exactly one duration unit" });
  for (const unit of supplied) {
    const minimum = RELATIVE_DUE_UNITS[unit].minimum;
    if (!Number.isSafeInteger(value[unit]) || value[unit] < minimum) {
      errors.push({ path: `$.${unit}`, message: `must be a safe integer greater than or equal to ${minimum}` });
    }
  }
  return errors;
}

function buildDueAtSchema() {
  const absolute = {
    type: "object",
    additionalProperties: false,
    required: ["mode", "date"],
    properties: {
      mode: { const: "absolute" },
      date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    },
  };
  const relative = Object.entries(RELATIVE_DUE_UNITS).map(([unit, { minimum }]) => ({
    type: "object",
    additionalProperties: false,
    required: ["mode", unit],
    properties: {
      mode: { const: "relative" },
      [unit]: { type: "integer", minimum },
    },
  }));
  const dayOfMonth = {
    type: "object",
    additionalProperties: false,
    required: ["mode", "day"],
    properties: {
      mode: { const: "dayOfMonth" },
      day: { type: "integer", minimum: 1, maximum: 31 },
    },
  };
  return { oneOf: [absolute, ...relative, dayOfMonth] };
}

module.exports = {
  RELATIVE_DUE_UNITS,
  MESSAGE_ANCHORED_DUE_MODES,
  dueAtRequiresMessageAnchor,
  validCalendarDate,
  validateDueAtExpression,
  buildDueAtSchema,
};
