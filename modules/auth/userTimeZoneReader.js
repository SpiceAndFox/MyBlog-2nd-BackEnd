const { normalizeIanaTimeZone } = require("../../utils/timeZone");

function createUserTimeZoneReader({ database } = {}) {
  if (!database?.query) throw new Error("Auth User time-zone reader requires a database query adapter");

  async function getTimeZone(userId, { client } = {}) {
    const executor = client?.query ? client : database;
    const { rows } = await executor.query("SELECT time_zone FROM users WHERE id=$1", [userId]);
    if (!rows[0]) throw new Error("Memory task user does not exist");
    return normalizeIanaTimeZone(rows[0].time_zone);
  }

  return Object.freeze({ getTimeZone });
}

module.exports = { createUserTimeZoneReader };
