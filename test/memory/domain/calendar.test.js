const test = require("node:test");
const assert = require("node:assert/strict");
const { nextDayOfMonth } = require("../../../modules/memory/domain/calendar");

test("day-of-month resolution selects the current or next valid local occurrence", () => {
  assert.equal(
    nextDayOfMonth("2026-07-08T16:30:00.000Z", 9, "Asia/Shanghai"),
    "2026-07-09T16:00:00.000Z",
  );
  assert.equal(
    nextDayOfMonth("2026-07-09T02:00:00.000Z", 9, "Asia/Shanghai"),
    "2026-07-09T16:00:00.000Z",
  );
  assert.equal(
    nextDayOfMonth("2026-07-09T16:30:00.000Z", 9, "Asia/Shanghai"),
    "2026-08-09T16:00:00.000Z",
  );
});

test("day-of-month resolution skips months where the requested date does not exist", () => {
  assert.equal(
    nextDayOfMonth("2026-01-31T12:00:00.000Z", 30, "UTC"),
    "2026-03-31T00:00:00.000Z",
  );
});
